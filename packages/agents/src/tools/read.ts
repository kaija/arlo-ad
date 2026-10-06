// Read tools over synced data (Requirements 2.8, 10.5). Every tool scopes accounts to the
// requesting user and returns money in account currency units.
import { addDays, dateInTimeZone, deriveMetrics, forecastMonthSpend, isIsoDate, microsToUnits } from '@arlo/core';
import {
  dailySpend,
  findEntities,
  listCampaigns,
  listChangeEvents,
  queryMetrics,
  resolveAccounts,
  type AdAccount,
  type MetricsRow,
} from '@arlo/db';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentContext } from '../context';

export class ToolInputError extends Error {}

function ctxOf(runContext?: RunContext<AgentContext>): AgentContext {
  if (!runContext?.context?.db) throw new Error('agent context missing');
  return runContext.context;
}

async function accountsFor(ctx: AgentContext, account: string | null): Promise<AdAccount[]> {
  const accounts = await resolveAccounts(ctx.db, { allowed: ctx.allowedAccountIds, account });
  if (account && accounts.length === 0) throw new ToolInputError(`找不到你有權限的帳戶「${account}」。可先呼叫 list_campaigns 取得帳戶清單。`);
  return accounts;
}

function dateRange(account: AdAccount, now: Date, from: string | null, to: string | null) {
  const today = dateInTimeZone(now, account.timezone);
  const end = to ?? addDays(today, -1);
  const start = from ?? addDays(end, -6);
  if (!isIsoDate(start) || !isIsoDate(end) || start > end) throw new ToolInputError('日期需為 YYYY-MM-DD，且 from ≤ to。');
  return { from: start, to: end };
}

const round = (n: number | null, digits = 4) => (n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

function presentMetrics(r: MetricsRow) {
  const d = deriveMetrics(r);
  return {
    ...(r.date ? { date: r.date } : {}),
    ...(r.entityName !== null || r.entityId ? { name: r.entityName } : {}),
    cost: microsToUnits(r.costMicros),
    impressions: r.impressions,
    clicks: r.clicks,
    conversions: round(r.conversions, 2),
    convValue: round(r.convValue, 2),
    ctr: round(d.ctr),
    cpc: round(microsToUnits(d.cpcMicros), 2),
    cpa: round(microsToUnits(d.cpaMicros), 2),
    roas: round(d.roas, 2),
    searchImpressionShare: round(r.searchIs),
    lostIsBudget: round(r.lostIsBudget),
    lostIsRank: round(r.lostIsRank),
  };
}

const accountParam = z
  .string()
  .nullable()
  .describe('帳戶名稱、Google Ads customer ID 或內部 id；null 代表所有你有權限的帳戶');

// --- query_metrics ---------------------------------------------------------------------

export const QueryMetricsParams = z.object({
  account: accountParam,
  level: z.enum(['account', 'campaign', 'ad_group', 'keyword']).describe('彙整層級'),
  from: z.string().nullable().describe('開始日期 YYYY-MM-DD（帳戶時區）；null = to 往前 7 天'),
  to: z.string().nullable().describe('結束日期 YYYY-MM-DD；null = 昨天'),
  groupBy: z.enum(['total', 'day', 'entity']).describe('total：區間合計；day：逐日；entity：依 campaign / ad group / keyword 分列'),
  campaigns: z.array(z.string()).nullable().describe('僅 level=campaign：限定的 campaign ID 或內部 id'),
  limit: z.number().int().min(1).max(200).nullable().describe('entity 分列最多幾筆（依花費排序），預設 50'),
});

export async function runQueryMetrics(ctx: AgentContext, p: z.infer<typeof QueryMetricsParams>) {
  if (p.campaigns?.length && p.level !== 'campaign') throw new ToolInputError('campaigns 篩選只適用 level=campaign。');
  const out = [];
  for (const account of await accountsFor(ctx, p.account)) {
    const range = dateRange(account, ctx.now(), p.from, p.to);
    const entityIds = p.campaigns?.length ? (await findEntities(ctx.db, [account.id], 'campaign', p.campaigns)).map((e) => e.id) : undefined;
    if (entityIds && entityIds.length === 0) continue;
    const rows = await queryMetrics(ctx.db, { accountIds: [account.id], level: p.level, ...range, entityIds, groupBy: p.groupBy, limit: p.limit ?? undefined });
    out.push({ account: account.name, customerId: account.externalId, currency: account.currency, ...range, rows: rows.map(presentMetrics) });
  }
  return { level: p.level, groupBy: p.groupBy, accounts: out };
}

// --- list_campaigns --------------------------------------------------------------------

export const ListCampaignsParams = z.object({
  account: accountParam,
  includePaused: z.boolean().nullable().describe('是否包含已暫停的 campaign，預設 true'),
});

export async function runListCampaigns(ctx: AgentContext, p: z.infer<typeof ListCampaignsParams>) {
  const accounts = await accountsFor(ctx, p.account);
  const rows = await listCampaigns(ctx.db, accounts.map((a) => a.id));
  return {
    accounts: accounts.map((a) => ({ account: a.name, customerId: a.externalId, currency: a.currency, timezone: a.timezone })),
    campaigns: rows
      .filter((c) => p.includePaused !== false || c.status === 'ENABLED')
      .map((c) => ({
        account: c.accountName,
        campaignId: c.externalId,
        name: c.name,
        status: c.status,
        dailyBudget: microsToUnits(c.budgetMicros),
        currency: c.currency,
        bidStrategy: c.bidStrategy,
        // tCPA in micros vs tROAS as a ratio, depending on the strategy.
        target: c.bidTarget === null ? null : /ROAS|CONVERSION_VALUE/.test(c.bidStrategy ?? '') ? { roas: c.bidTarget } : { cpa: microsToUnits(c.bidTarget) },
        stateAsOf: c.snapshotAt?.toISOString() ?? null,
      })),
  };
}

// --- get_pacing ------------------------------------------------------------------------

export const GetPacingParams = z.object({ account: accountParam });

export async function runGetPacing(ctx: AgentContext, p: z.infer<typeof GetPacingParams>) {
  const out = [];
  for (const account of await accountsFor(ctx, p.account)) {
    const today = dateInTimeZone(ctx.now(), account.timezone);
    const history = await dailySpend(ctx.db, [account.id], addDays(today, -35), today);
    const budget = (await listCampaigns(ctx.db, [account.id]))
      .filter((c) => c.status === 'ENABLED')
      .reduce((s, c) => s + (c.budgetMicros ?? 0), 0);
    const r = forecastMonthSpend({ today, history, dailyBudgetMicros: budget || null });
    out.push({
      account: account.name,
      currency: account.currency,
      today,
      monthToDate: microsToUnits(r.mtdMicros),
      projectedMonthTotal: microsToUnits(r.projectedMicros),
      linearProjection: microsToUnits(r.linearProjectedMicros),
      dailyRunRate: microsToUnits(r.dailyRateMicros),
      enabledDailyBudgets: microsToUnits(budget),
      budgetPace: round(r.budgetPace),
      daysElapsed: r.daysElapsed,
      daysInMonth: r.daysInMonth,
    });
  }
  return { accounts: out, note: '當日數據每小時同步，可能延遲至多 1 小時；轉換會在 3 天內回補。' };
}

// --- get_change_history ----------------------------------------------------------------

export const GetChangeHistoryParams = z.object({
  account: accountParam,
  from: z.string().nullable().describe('開始日期 YYYY-MM-DD；null = 7 天前'),
  to: z.string().nullable().describe('結束日期 YYYY-MM-DD（含）；null = 今天'),
  resource: z.string().nullable().describe('只看 resource name 含此 ID 的變更，例如 campaign ID'),
  limit: z.number().int().min(1).max(200).nullable(),
});

const clip = (v: unknown) => {
  const s = JSON.stringify(v ?? null);
  return s.length > 500 ? `${s.slice(0, 500)}…` : JSON.parse(s);
};

export async function runGetChangeHistory(ctx: AgentContext, p: z.infer<typeof GetChangeHistoryParams>) {
  const accounts = await accountsFor(ctx, p.account);
  const now = ctx.now();
  for (const d of [p.from, p.to]) if (d && !isIsoDate(d)) throw new ToolInputError('日期需為 YYYY-MM-DD。');
  const from = p.from ? new Date(`${p.from}T00:00:00Z`) : new Date(now.getTime() - 7 * 86_400_000);
  const to = p.to ? new Date(`${addDays(p.to, 1)}T00:00:00Z`) : now;
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const events = await listChangeEvents(ctx.db, {
    accountIds: accounts.map((a) => a.id),
    from,
    to,
    resourceContains: p.resource ?? undefined,
    limit: p.limit ?? 50,
  });
  return {
    events: events.map((e) => ({
      account: names.get(e.accountId),
      changedAt: e.changedAt.toISOString(),
      user: e.userEmail,
      client: e.clientType,
      resourceType: e.resourceType,
      resourceName: e.resourceName,
      fields: e.changedFields,
      old: clip(e.old),
      new: clip(e.new),
    })),
  };
}

// --- tool definitions ------------------------------------------------------------------

export const queryMetricsTool = tool({
  name: 'query_metrics',
  description: '查詢廣告成效（花費、曝光、點擊、轉換、CTR、CPC、CPA、ROAS、曝光比重），資料來自每日同步的 Postgres。',
  parameters: QueryMetricsParams,
  execute: (p, rc?: RunContext<AgentContext>) => runQueryMetrics(ctxOf(rc), p),
});

export const listCampaignsTool = tool({
  name: 'list_campaigns',
  description: '列出帳戶與 campaign 的狀態、每日預算與出價策略／目標（最新 15 分鐘 snapshot）。',
  parameters: ListCampaignsParams,
  execute: (p, rc?: RunContext<AgentContext>) => runListCampaigns(ctxOf(rc), p),
});

export const getPacingTool = tool({
  name: 'get_pacing',
  description: '本月至今花費、月底花費預測（考慮星期效應）與相對每日預算的 pacing。',
  parameters: GetPacingParams,
  execute: (p, rc?: RunContext<AgentContext>) => runGetPacing(ctxOf(rc), p),
});

export const getChangeHistoryTool = tool({
  name: 'get_change_history',
  description: '查詢 Google Ads 變更紀錄（誰在何時改了什麼），用於解釋成效變化。',
  parameters: GetChangeHistoryParams,
  execute: (p, rc?: RunContext<AgentContext>) => runGetChangeHistory(ctxOf(rc), p),
});

export const analystTools = [queryMetricsTool, listCampaignsTool, getPacingTool, getChangeHistoryTool];
