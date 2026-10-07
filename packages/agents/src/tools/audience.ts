// Audience tools (ADR-0022, Requirement 17): segment performance from synced g_audience_metrics,
// bid-modifier and exclusion proposals (always Tier 2). Suggested modifiers come from core's
// suggestAudienceAction; the agent picks segments. User lists are ids and names only, no PII.
import { addDays, AUDIENCE_MODIFIER_MAX, AUDIENCE_MODIFIER_MIN, authorize, dateInTimeZone, microsToUnits, suggestAudienceAction, type AudienceSuggestion, type Op } from '@arlo/core';
import { audienceStats, getUserWithBindings, listCampaigns, queryMetrics, resolveAccounts, type AdAccount, type AudienceStatsRow } from '@arlo/db';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentContext } from '../context';
import { ToolInputError } from './read';

/** Audience metrics are synced for the last 30 days. */
const WINDOW_DAYS = 30;

function ctxOf(runContext?: RunContext<AgentContext>): AgentContext {
  if (!runContext?.context?.db) throw new Error('agent context missing');
  return runContext.context;
}

async function oneAccount(ctx: AgentContext, account: string): Promise<AdAccount> {
  const [acc, more] = await resolveAccounts(ctx.db, { allowed: ctx.allowedAccountIds, account });
  if (!acc) throw new ToolInputError(`找不到你有權限的帳戶「${account}」。`);
  if (more) throw new ToolInputError(`「${account}」對應到多個帳戶，請改用 customer ID。`);
  return acc;
}

async function assertCanPropose(ctx: AgentContext, acc: AdAccount) {
  if (!ctx.propose) throw new ToolInputError('這個情境不允許提出變更。');
  if (!ctx.user) return;
  const user = await getUserWithBindings(ctx.db, ctx.user.id);
  if (!user || !authorize(user, 'propose', { accountId: acc.id }).allowed) throw new ToolInputError('發問者沒有在這個帳戶提出變更的權限（需要 operator 以上）。');
}

interface SegmentRow extends AudienceStatsRow {
  suggestion: AudienceSuggestion;
}

/** Every synced segment over the window with its deterministic suggestion. */
export async function audienceSegments(ctx: AgentContext, acc: AdAccount, opts: { valueBased: boolean }): Promise<SegmentRow[]> {
  const today = dateInTimeZone(ctx.now(), acc.timezone);
  const range = { from: addDays(today, -WINDOW_DAYS), to: addDays(today, -1) };
  const stats = await audienceStats(ctx.db, acc.id, range);
  if (stats.length === 0) return [];
  const campaignIds = [...new Set(stats.map((s) => s.campaignId))];
  const [totals, campaigns] = await Promise.all([
    queryMetrics(ctx.db, { accountIds: [acc.id], level: 'campaign', ...range, entityIds: campaignIds, groupBy: 'entity', limit: campaignIds.length }),
    listCampaigns(ctx.db, [acc.id]),
  ]);
  return stats.map((s) => {
    const total = totals.find((t) => t.entityId === s.campaignId);
    const suggestion = suggestAudienceAction({
      bidStrategy: campaigns.find((c) => c.campaignId === s.campaignId)?.bidStrategy ?? null,
      currentModifier: s.bidModifier,
      segment: s,
      campaign: total ?? { costMicros: 0, clicks: 0, conversions: 0, convValue: 0 },
      valueBased: opts.valueBased,
    });
    return { ...s, suggestion };
  });
}

function matchCampaign(rows: readonly SegmentRow[], campaign: string): SegmentRow[] {
  const wanted = campaign.trim();
  const ids = new Set(rows.filter((r) => r.campaignExternalId === wanted || r.campaignId === wanted || r.campaignName?.toLowerCase() === wanted.toLowerCase()).map((r) => r.campaignId));
  if (ids.size !== 1) throw new ToolInputError(`找不到唯一且有受眾資料的 campaign「${campaign}」。`);
  return rows.filter((r) => ids.has(r.campaignId));
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// --- get_audience_metrics ---------------------------------------------------------------------

export const GetAudienceMetricsParams = z.object({
  account: z.string().describe('帳戶名稱或 Google Ads customer ID'),
  campaign: z.string().nullable().describe('只看某個 campaign（ID 或名稱）；null = 全部'),
  optimizeFor: z.enum(['conversions', 'value']).nullable().describe('以 CPA（預設）或 ROAS 比較'),
});

export async function runGetAudienceMetrics(ctx: AgentContext, p: z.infer<typeof GetAudienceMetricsParams>) {
  const acc = await oneAccount(ctx, p.account);
  const all = await audienceSegments(ctx, acc, { valueBased: p.optimizeFor === 'value' });
  const rows = p.campaign ? matchCampaign(all, p.campaign) : all;
  return {
    account: acc.name,
    currency: acc.currency,
    days: WINDOW_DAYS,
    segments: rows.slice(0, 100).map((r) => ({
      campaignId: r.campaignExternalId,
      campaign: r.campaignName,
      userListId: r.userListId,
      audience: r.userListName,
      mode: r.targetingMode,
      bidModifier: r.bidModifier,
      cost: microsToUnits(r.costMicros),
      clicks: r.clicks,
      conversions: round(r.conversions, 1),
      cpa: r.conversions > 0 ? round(r.costMicros / 1_000_000 / r.conversions) : null,
      roas: r.costMicros > 0 ? round(r.convValue / (r.costMicros / 1_000_000)) : null,
      suggestion: r.suggestion,
    })),
    note: rows.length === 0 ? '沒有同步到受眾資料（campaign 需要加上 observation 或 targeting 受眾）。' : '建議由系統依 campaign 平均計算；出價調整只對手動出價有效。',
  };
}

export const getAudienceMetricsTool = tool({
  name: 'get_audience_metrics',
  description: `近 ${WINDOW_DAYS} 天各 campaign 的受眾區隔（user list，observation / targeting）成效，附系統計算的出價調整或排除建議。`,
  parameters: GetAudienceMetricsParams,
  execute: (p, rc?: RunContext<AgentContext>) => runGetAudienceMetrics(ctxOf(rc), p),
});

// --- propose_audience_modifier ----------------------------------------------------------------

export const ProposeAudienceModifierParams = z.object({
  account: z.string().describe('帳戶名稱或 Google Ads customer ID'),
  campaign: z.string().describe('campaign ID 或名稱'),
  changes: z
    .array(
      z.object({
        userListId: z.string().describe('get_audience_metrics 回傳的 userListId'),
        bidModifier: z.number().nullable().describe('使用者明確指定的倍數（1.2 = +20%）；null = 採用系統建議'),
      }),
    )
    .min(1)
    .max(20),
  optimizeFor: z.enum(['conversions', 'value']).nullable().describe('採用建議時的比較基準，需與 get_audience_metrics 一致'),
  reason: z.string().max(1000).nullable(),
});

export async function runProposeAudienceModifier(ctx: AgentContext, p: z.infer<typeof ProposeAudienceModifierParams>) {
  const acc = await oneAccount(ctx, p.account);
  await assertCanPropose(ctx, acc);
  const rows = matchCampaign(await audienceSegments(ctx, acc, { valueBased: p.optimizeFor === 'value' }), p.campaign);
  if (new Set(p.changes.map((c) => c.userListId)).size !== p.changes.length) throw new ToolInputError('同一個受眾只能出現一次。');
  const planned = p.changes.map((c) => {
    const row = rows.find((r) => r.userListId === c.userListId.trim());
    if (!row) throw new ToolInputError(`campaign 上沒有受眾 ${c.userListId} 的資料。`);
    if (c.bidModifier === null) {
      if (row.suggestion.action !== 'modifier') throw new ToolInputError(`受眾「${row.userListName ?? row.userListId}」目前沒有出價調整建議（${row.suggestion.reason}）。`);
      return { row, after: row.suggestion.after, why: row.suggestion.reason };
    }
    if (!(c.bidModifier >= AUDIENCE_MODIFIER_MIN && c.bidModifier <= AUDIENCE_MODIFIER_MAX)) throw new ToolInputError(`出價調整倍數需介於 ${AUDIENCE_MODIFIER_MIN} 與 ${AUDIENCE_MODIFIER_MAX}。`);
    return { row, after: round(c.bidModifier), why: '使用者指定' };
  });
  const first = rows[0]!;
  const target = { platform: acc.platform, accountId: acc.externalId, kind: 'campaign' as const, id: first.campaignExternalId };
  const ops: Op[] = planned.map(({ row, after }) => ({
    kind: 'google.set_audience_bid_modifier',
    target,
    before: { userListId: row.userListId, bidModifier: row.bidModifier ?? 1 },
    after: { userListId: row.userListId, bidModifier: after },
    meta: { minTier: 2 },
  }));
  const cs = await ctx.propose!({
    accountId: acc.id,
    source: ctx.source ?? { kind: 'chat' },
    ops,
    summary: `調整「${first.campaignName ?? first.campaignExternalId}」${ops.length} 個受眾的出價`,
    rationale: [p.reason, ...planned.map(({ row, why }) => `${row.userListName ?? row.userListId}：${why}`)].filter(Boolean).join('\n'),
    requestedBy: ctx.user ? { kind: 'user', userId: ctx.user.id } : { kind: 'agent' },
    traceId: ctx.traceId ?? null,
  });
  return {
    changesetId: cs.id,
    status: 'PENDING_VALIDATION',
    changes: planned.map(({ row, after }) => ({ audience: row.userListName ?? row.userListId, before: row.bidModifier ?? 1, after })),
    note: '受眾出價調整一律需要人工核准。',
  };
}

export const proposeAudienceModifierTool = tool({
  name: 'propose_audience_modifier',
  description: '提出某個 campaign 的受眾出價調整（建立待審核的 ChangeSet，一律需要人工核准）。',
  parameters: ProposeAudienceModifierParams,
  execute: (p, rc?: RunContext<AgentContext>) => runProposeAudienceModifier(ctxOf(rc), p),
});

// --- propose_audience_exclusion ---------------------------------------------------------------

export const ProposeAudienceExclusionParams = z.object({
  account: z.string().describe('帳戶名稱或 Google Ads customer ID'),
  campaign: z.string().describe('campaign ID 或名稱'),
  userListIds: z.array(z.string()).min(1).max(20).describe('要從 campaign 排除的受眾（get_audience_metrics 的 userListId）'),
  reason: z.string().max(1000).nullable(),
});

export async function runProposeAudienceExclusion(ctx: AgentContext, p: z.infer<typeof ProposeAudienceExclusionParams>) {
  const acc = await oneAccount(ctx, p.account);
  await assertCanPropose(ctx, acc);
  const rows = matchCampaign(await audienceSegments(ctx, acc, { valueBased: false }), p.campaign);
  const chosen = [...new Set(p.userListIds.map((id) => id.trim()))].map((id) => {
    const row = rows.find((r) => r.userListId === id);
    if (!row) throw new ToolInputError(`campaign 上沒有受眾 ${id} 的資料。`);
    return row;
  });
  const first = rows[0]!;
  const target = { platform: acc.platform, accountId: acc.externalId, kind: 'campaign' as const, id: first.campaignExternalId };
  const ops: Op[] = chosen.map((row) => ({ kind: 'google.exclude_audience', target, before: null, after: { userListId: row.userListId }, meta: { minTier: 2 } }));
  const cs = await ctx.propose!({
    accountId: acc.id,
    source: ctx.source ?? { kind: 'chat' },
    ops,
    summary: `從「${first.campaignName ?? first.campaignExternalId}」排除 ${ops.length} 個受眾`,
    rationale: [p.reason, ...chosen.map((r) => `${r.userListName ?? r.userListId}：${r.suggestion.reason}`)].filter(Boolean).join('\n'),
    requestedBy: ctx.user ? { kind: 'user', userId: ctx.user.id } : { kind: 'agent' },
    traceId: ctx.traceId ?? null,
  });
  return { changesetId: cs.id, status: 'PENDING_VALIDATION', excluded: chosen.map((r) => r.userListName ?? r.userListId), note: '排除受眾一律需要人工核准。' };
}

export const proposeAudienceExclusionTool = tool({
  name: 'propose_audience_exclusion',
  description: '提出從某個 campaign 排除受眾（建立待審核的 ChangeSet，一律需要人工核准）。',
  parameters: ProposeAudienceExclusionParams,
  execute: (p, rc?: RunContext<AgentContext>) => runProposeAudienceExclusion(ctxOf(rc), p),
});
