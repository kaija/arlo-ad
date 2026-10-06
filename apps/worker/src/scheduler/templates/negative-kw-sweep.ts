// negative_kw_sweep (ADR-0019, Requirements 14.2–14.6): classify recent search terms against the
// Business Profile, exclude the clear-cut ones automatically (Tier 1, feature negative_kw_auto,
// subject to the automation mode) and send the rest for review as one Tier 2 batch whose ops the
// approver can untick. Deterministic apart from the classifier; ChangeSets go to the Executor.
import { classifySearchTerms } from '@arlo/agents';
import {
  addDays,
  AUTO_NEGATIVE_LIST_NAME,
  autoNegativeDecision,
  dateInTimeZone,
  type Op,
  type Section,
} from '@arlo/core';
import { findSharedSet, getAutomationMode, getBusinessProfile, proposedNegativeTerms, searchTermStats, type AdAccount } from '@arlo/db';
import type { TemplateContext, TemplateHandler } from '../types';

/** Terms with spend in this window are swept; conversions look back further (Requirement 14.4). */
export const SWEEP_COST_DAYS = 30;
export const SWEEP_CONVERSION_DAYS = 90;
/** Ops per review batch, so a card stays reviewable. */
export const REVIEW_BATCH_MAX = 40;

interface AccountOutcome {
  account: AdAccount;
  skipped?: string;
  classified: number;
  cached: number;
  auto: string[];
  review: string[];
  changesetIds: string[];
}

async function sweepAccount(ctx: TemplateContext, account: AdAccount): Promise<AccountOutcome> {
  const out: AccountOutcome = { account, classified: 0, cached: 0, auto: [], review: [], changesetIds: [] };
  if (!ctx.agents.searchTermClassifier || !ctx.propose) return { ...out, skipped: '分類器或提案功能未設定' };
  const stored = await getBusinessProfile(ctx.db, account.id);
  if (!stored) return { ...out, skipped: '尚未設定 Business Profile' };
  const list = await findSharedSet(ctx.db, account.id, AUTO_NEGATIVE_LIST_NAME);
  if (!list) return { ...out, skipped: `找不到共用否定關鍵字清單「${AUTO_NEGATIVE_LIST_NAME}」，請在 Google Ads 建立並套用到 campaign` };

  const today = dateInTimeZone(ctx.now(), account.timezone);
  const stats = (await searchTermStats(ctx.db, account.id, { costFrom: addDays(today, -SWEEP_COST_DAYS), convFrom: addDays(today, -SWEEP_CONVERSION_DAYS), to: today })).filter((s) => s.costMicros > 0);
  const already = await proposedNegativeTerms(ctx.db, account.id);
  const fresh = stats.filter((s) => !already.has(s.term));
  if (fresh.length === 0) return out;

  const { labels, cached, classified } = await classifySearchTerms({
    db: ctx.db,
    accountId: account.id,
    profile: stored.profile,
    profileVersion: stored.version,
    terms: fresh.map((s) => s.term),
    classifier: ctx.agents.searchTermClassifier(),
  });
  out.cached = cached;
  out.classified = classified;

  const target = { platform: account.platform, accountId: account.externalId, kind: 'shared_set' as const, id: list.externalId };
  const negative = (term: string, meta: Record<string, unknown>): Op => ({ kind: 'google.add_negative_keyword', target, before: null, after: { text: term, matchType: 'EXACT' }, meta });
  const mode = await getAutomationMode(ctx.db, account.id, 'negative_kw_auto');
  const autoOps: Op[] = [];
  const reviewOps: Op[] = [];
  for (const s of fresh) {
    const label = labels.get(s.term);
    if (!label) continue;
    const { decision, reason } = autoNegativeDecision({ term: s.term, label, conversions90d: s.conversions, costMicros: s.costMicros }, stored.profile.brandTerms);
    if (decision === 'keep') continue;
    const meta = { term: s.term, intent: label.intent, confidence: label.confidence, reason: label.reason, costMicros: s.costMicros, conversions90d: s.conversions, profileVersion: stored.version };
    // With the automation off, would-be automatic exclusions go to review instead (ADR-0013).
    if (decision === 'auto' && mode !== 'off') autoOps.push(negative(s.term, meta));
    else reviewOps.push(negative(s.term, { ...meta, minTier: 2, reviewReason: decision === 'auto' ? '自動否定已關閉' : reason }));
  }

  const source = { kind: 'schedule' as const, jobRunId: ctx.run.id };
  if (autoOps.length) {
    const cs = await ctx.propose({
      accountId: account.id,
      feature: 'negative_kw_auto',
      source,
      ops: autoOps,
      summary: `自動排除 ${autoOps.length} 個不相關搜尋字詞（EXACT → ${AUTO_NEGATIVE_LIST_NAME}）`,
      rationale: `Business Profile 第 ${stored.version} 版判定不相關、信心 ≥ 0.9、近 ${SWEEP_CONVERSION_DAYS} 天無轉換、不含品牌字`,
      requestedBy: { kind: 'system' },
      traceId: ctx.traceId ?? null,
    });
    out.auto = autoOps.map((o) => (o.after as { text: string }).text);
    out.changesetIds.push(cs.id);
  }
  for (let i = 0; i < reviewOps.length; i += REVIEW_BATCH_MAX) {
    const batch = reviewOps.slice(i, i + REVIEW_BATCH_MAX);
    const cs = await ctx.propose({
      accountId: account.id,
      source,
      ops: batch,
      summary: `審核 ${batch.length} 個可能不相關的搜尋字詞（EXACT 否定）`,
      rationale: '分類器判定不相關但未達自動排除條件；取消勾選的字詞會記入 Business Profile 作為相關範例',
      requestedBy: { kind: 'system' },
      traceId: ctx.traceId ?? null,
    });
    out.review.push(...batch.map((o) => (o.after as { text: string }).text));
    out.changesetIds.push(cs.id);
  }
  return out;
}

export function sweepSections(outcomes: readonly AccountOutcome[]): Section[] {
  return outcomes.map((o): Section => {
    if (o.skipped) return { kind: 'text', heading: o.account.name, text: `略過：${o.skipped}` };
    const lines = [
      `分類 ${o.classified} 個新字詞（快取 ${o.cached}）`,
      o.auto.length ? `自動排除 ${o.auto.length} 個：${o.auto.slice(0, 10).join('、')}${o.auto.length > 10 ? '…' : ''}` : '沒有符合自動排除條件的字詞',
      o.review.length ? `送審核 ${o.review.length} 個` : '沒有需要審核的字詞',
    ];
    return { kind: 'text', heading: o.account.name, text: lines.map((l) => `• ${l}`).join('\n') };
  });
}

export const negativeKwSweep: TemplateHandler = {
  critical: false,
  async run(ctx) {
    const outcomes: AccountOutcome[] = [];
    for (const account of ctx.accounts) outcomes.push(await sweepAccount(ctx, account));
    const changesetIds = outcomes.flatMap((o) => o.changesetIds);
    return {
      messages: [{ type: 'report', title: '否定關鍵字掃描', sections: outcomes.length ? sweepSections(outcomes) : [{ kind: 'text', text: '沒有可掃描的帳戶。' }] }],
      changesetIds,
    };
  },
};
