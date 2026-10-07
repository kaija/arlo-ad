// Keyword-domain read tools (ADR-0019): Business Profile and search terms context.
import { addDays, AUTO_NEGATIVE_LIST_NAME, authorize, dateInTimeZone, keywordCandidates, microsToUnits, normalizeSearchTerm, type Op } from '@arlo/core';
import { findSharedSet, getBusinessProfile, getSearchTermLabels, getUserWithBindings, listCampaigns, proposedNegativeTerms, resolveAccounts, schema, searchTermStats, type AdAccount } from '@arlo/db';
import { and, eq, sql } from 'drizzle-orm';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentContext } from '../context';
import { ToolInputError } from './read';

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

export const GetBusinessProfileParams = z.object({ account: z.string().describe('帳戶名稱或 Google Ads customer ID') });

export async function runGetBusinessProfile(ctx: AgentContext, p: z.infer<typeof GetBusinessProfileParams>) {
  const account = await oneAccount(ctx, p.account);
  const stored = await getBusinessProfile(ctx.db, account.id);
  if (!stored) return { account: account.name, version: null, profile: null, note: '這個帳戶還沒有 Business Profile；判斷字詞相關性前請提醒 admin 在 Web 設定。' };
  return { account: account.name, version: stored.version, profile: stored.profile };
}

export const getBusinessProfileTool = tool({
  name: 'get_business_profile',
  description: '取得帳戶的 Business Profile：販售內容、想要／排除的搜尋意圖、品牌字、競品政策與已標註的範例字詞。',
  parameters: GetBusinessProfileParams,
  execute: (p, rc?: RunContext<AgentContext>) => runGetBusinessProfile(ctxOf(rc), p),
});

// --- get_search_terms --------------------------------------------------------------------

export const GetSearchTermsParams = z.object({
  account: z.string().describe('帳戶名稱或 Google Ads customer ID'),
  days: z.number().int().min(1).max(90).nullable().describe('花費統計天數，預設 30；轉換固定看 90 天'),
  limit: z.number().int().min(1).max(200).nullable().describe('依花費排序取前幾個，預設 50'),
  onlyWithoutConversions: z.boolean().nullable().describe('只列 90 天內沒有轉換的字詞'),
});

export async function runGetSearchTerms(ctx: AgentContext, p: z.infer<typeof GetSearchTermsParams>) {
  const acc = await oneAccount(ctx, p.account);
  const today = dateInTimeZone(ctx.now(), acc.timezone);
  const stats = await searchTermStats(ctx.db, acc.id, { costFrom: addDays(today, -(p.days ?? 30)), convFrom: addDays(today, -90), to: today, limit: 500 });
  const rows = stats.filter((s) => s.costMicros > 0 && (!p.onlyWithoutConversions || s.conversions === 0)).slice(0, p.limit ?? 50);
  const profile = await getBusinessProfile(ctx.db, acc.id);
  const labels = profile ? await getSearchTermLabels(ctx.db, acc.id, profile.version, rows.map((r) => r.term)) : new Map();
  return {
    account: acc.name,
    currency: acc.currency,
    profileVersion: profile?.version ?? null,
    terms: rows.map((r) => {
      const l = labels.get(r.term);
      return { term: r.term, cost: microsToUnits(r.costMicros), clicks: r.clicks, conversions90d: r.conversions, ...(l ? { label: { intent: l.intent, relevant: l.relevant, confidence: l.confidence, reason: l.reason } } : {}) };
    }),
  };
}

export const getSearchTermsTool = tool({
  name: 'get_search_terms',
  description: '列出帳戶近期有花費的搜尋字詞（花費、點擊、90 天轉換），附上分類器對目前 Business Profile 的判定（若有）。',
  parameters: GetSearchTermsParams,
  execute: (p, rc?: RunContext<AgentContext>) => runGetSearchTerms(ctxOf(rc), p),
});

// --- propose_negative_keywords ---------------------------------------------------------------

export const ProposeNegativeKeywordsParams = z.object({
  account: z.string().describe('帳戶名稱或 Google Ads customer ID'),
  terms: z.array(z.string().min(1).max(80)).min(1).max(100).describe('要排除的字詞'),
  matchType: z.enum(['EXACT', 'PHRASE']).describe('比對類型；EXACT 最窄，PHRASE 會排除包含該片語的搜尋'),
  campaign: z.string().nullable().describe('只加到某個 campaign（ID 或名稱）；null = 加到共用清單 arlo-auto-negatives'),
  reason: z.string().nullable().describe('理由（顯示在審核卡片）'),
});

export async function runProposeNegativeKeywords(ctx: AgentContext, p: z.infer<typeof ProposeNegativeKeywordsParams>) {
  if (!ctx.propose) throw new ToolInputError('這個情境不允許提出變更。');
  const acc = await oneAccount(ctx, p.account);
  if (ctx.user) {
    const user = await getUserWithBindings(ctx.db, ctx.user.id);
    if (!user || !authorize(user, 'propose', { accountId: acc.id }).allowed) throw new ToolInputError('發問者沒有在這個帳戶提出變更的權限（需要 operator 以上）。');
  }
  let target: Op['target'];
  if (p.campaign) {
    const wanted = p.campaign.trim().toLowerCase();
    const matches = (await listCampaigns(ctx.db, [acc.id])).filter((c) => c.externalId === p.campaign!.trim() || c.campaignId === p.campaign!.trim() || c.name?.toLowerCase() === wanted);
    if (matches.length !== 1) throw new ToolInputError(`找不到唯一的 campaign「${p.campaign}」。`);
    target = { platform: acc.platform, accountId: acc.externalId, kind: 'campaign', id: matches[0]!.externalId };
  } else {
    const list = await findSharedSet(ctx.db, acc.id, AUTO_NEGATIVE_LIST_NAME);
    if (!list) throw new ToolInputError(`帳戶沒有共用否定清單「${AUTO_NEGATIVE_LIST_NAME}」，請指定 campaign 或先在 Google Ads 建立清單。`);
    target = { platform: acc.platform, accountId: acc.externalId, kind: 'shared_set', id: list.externalId };
  }
  const terms = [...new Set(p.terms.map(normalizeSearchTerm).filter(Boolean))];
  const ops: Op[] = terms.map((text) => ({ kind: 'google.add_negative_keyword', target, before: null, after: { text, matchType: p.matchType } }));
  const cs = await ctx.propose({
    accountId: acc.id,
    source: ctx.source ?? { kind: 'chat' },
    ops,
    summary: `新增 ${ops.length} 個否定關鍵字（${p.matchType}）`,
    rationale: p.reason,
    requestedBy: ctx.user ? { kind: 'user', userId: ctx.user.id } : { kind: 'agent' },
    traceId: ctx.traceId ?? null,
  });
  return { changesetId: cs.id, status: 'PENDING_VALIDATION', terms, note: 'EXACT 否定屬保護性變更，可能直接執行並附 Undo；PHRASE 需要審核。回覆時附上 ChangeSet 編號。' };
}

export const proposeNegativeKeywordsTool = tool({
  name: 'propose_negative_keywords',
  description: '提出新增否定關鍵字（建立待驗證的 ChangeSet，不會直接生效）。',
  parameters: ProposeNegativeKeywordsParams,
  execute: (p, rc?: RunContext<AgentContext>) => runProposeNegativeKeywords(ctxOf(rc), p),
});

// --- keyword expansion (Requirement 14.7) -------------------------------------------------------

async function accountKeywords(ctx: AgentContext, acc: AdAccount) {
  const e = schema.entities;
  return ctx.db
    .select({ externalId: e.externalId, text: e.name, parentId: e.parentId })
    .from(e)
    .where(and(eq(e.accountId, acc.id), eq(e.kind, 'keyword'), sql`${e.status} is distinct from 'REMOVED'`));
}

export const GetKeywordIdeasParams = z.object({
  account: z.string().describe('帳戶名稱或 Google Ads customer ID'),
  seeds: z.array(z.string().min(1).max(80)).max(20).describe('Keyword Planner 的種子字詞（產品、品牌、類別）；可為空陣列只看搜尋字詞'),
});

/** Converting search terms that are not keywords yet, plus Keyword Planner ideas, de-duplicated. */
export async function runGetKeywordIdeas(ctx: AgentContext, p: z.infer<typeof GetKeywordIdeasParams>) {
  const acc = await oneAccount(ctx, p.account);
  const today = dateInTimeZone(ctx.now(), acc.timezone);
  const [stats, existing, negatives, ideas] = await Promise.all([
    searchTermStats(ctx.db, acc.id, { costFrom: addDays(today, -90), convFrom: addDays(today, -90), to: today, limit: 1000 }),
    accountKeywords(ctx, acc),
    proposedNegativeTerms(ctx.db, acc.id),
    p.seeds.length && ctx.keywordIdeas ? ctx.keywordIdeas(acc.externalId, p.seeds) : Promise.resolve([]),
  ]);
  const profile = await getBusinessProfile(ctx.db, acc.id);
  const candidates = keywordCandidates(
    ideas,
    stats.map((s) => ({ term: s.term, conversions: s.conversions, clicks: s.clicks, costMicros: s.costMicros })),
    { existing: existing.map((k) => k.text ?? '').filter(Boolean), negatives: [...negatives, ...(profile?.profile.excludedIntents ?? [])] },
  );
  return {
    account: acc.name,
    plannerAvailable: Boolean(ctx.keywordIdeas),
    candidates: candidates.map((c) => ({ text: c.text, source: c.source, suggestedMatchType: c.matchType, conversions90d: Math.round(c.conversions * 10) / 10, avgMonthlySearches: c.avgMonthlySearches, competition: c.competition, topOfPageBidHigh: c.highTopBidMicros === null ? null : microsToUnits(c.highTopBidMicros) })),
  };
}

export const ProposeKeywordsParams = z.object({
  account: z.string().describe('帳戶名稱或 Google Ads customer ID'),
  adGroup: z.string().describe('要加入的廣告群組 ID 或名稱'),
  keywords: z.array(z.object({ text: z.string().min(1).max(80), matchType: z.enum(['EXACT', 'PHRASE', 'BROAD']) })).min(1).max(50),
  reason: z.string().nullable(),
});

export async function runProposeKeywords(ctx: AgentContext, p: z.infer<typeof ProposeKeywordsParams>) {
  if (!ctx.propose) throw new ToolInputError('這個情境不允許提出變更。');
  const acc = await oneAccount(ctx, p.account);
  if (ctx.user) {
    const user = await getUserWithBindings(ctx.db, ctx.user.id);
    if (!user || !authorize(user, 'propose', { accountId: acc.id }).allowed) throw new ToolInputError('發問者沒有在這個帳戶提出變更的權限（需要 operator 以上）。');
  }
  const e = schema.entities;
  const groups = await ctx.db
    .select({ id: e.id, externalId: e.externalId, name: e.name })
    .from(e)
    .where(and(eq(e.accountId, acc.id), eq(e.kind, 'ad_group'), sql`${e.status} is distinct from 'REMOVED'`));
  const wanted = p.adGroup.trim().toLowerCase();
  const matches = groups.filter((g) => g.externalId === p.adGroup.trim() || g.name?.toLowerCase() === wanted);
  if (matches.length !== 1) throw new ToolInputError(`找不到唯一的廣告群組「${p.adGroup}」。`);
  const group = matches[0]!;
  const inGroup = new Set((await accountKeywords(ctx, acc)).filter((k) => k.parentId === group.id).map((k) => normalizeSearchTerm(k.text ?? '')));
  const seen = new Set<string>();
  const fresh = p.keywords.flatMap((k) => {
    const text = normalizeSearchTerm(k.text);
    const key = `${text}|${k.matchType}`;
    if (!text || inGroup.has(text) || seen.has(key)) return [];
    seen.add(key);
    return [{ text, matchType: k.matchType }];
  });
  if (fresh.length === 0) throw new ToolInputError('這些關鍵字都已在廣告群組中。');
  const ops: Op[] = fresh.map((k) => ({ kind: 'google.add_keyword', target: { platform: acc.platform, accountId: acc.externalId, kind: 'ad_group', id: group.externalId }, before: null, after: k, meta: { minTier: 2 } }));
  const cs = await ctx.propose({
    accountId: acc.id,
    source: ctx.source ?? { kind: 'chat' },
    ops,
    summary: `新增 ${ops.length} 個關鍵字到「${group.name ?? group.externalId}」`,
    rationale: p.reason,
    requestedBy: ctx.user ? { kind: 'user', userId: ctx.user.id } : { kind: 'agent' },
    traceId: ctx.traceId ?? null,
  });
  return { changesetId: cs.id, status: 'PENDING_VALIDATION', added: fresh, skipped: p.keywords.length - fresh.length, note: '新增關鍵字一律需要人工核准。' };
}

export const getKeywordIdeasTool = tool({
  name: 'get_keyword_ideas',
  description: '關鍵字擴展候選：近 90 天有轉換但還不是關鍵字的搜尋字詞，加上 Keyword Planner 依種子字詞的建議（已排除現有關鍵字與否定字）。',
  parameters: GetKeywordIdeasParams,
  execute: (p, rc?: RunContext<AgentContext>) => runGetKeywordIdeas(ctxOf(rc), p),
});

export const proposeKeywordsTool = tool({
  name: 'propose_keywords',
  description: '提出把關鍵字加入某個廣告群組（建立待審核的 ChangeSet，一律需要人工核准）。',
  parameters: ProposeKeywordsParams,
  execute: (p, rc?: RunContext<AgentContext>) => runProposeKeywords(ctxOf(rc), p),
});
