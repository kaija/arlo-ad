// daily_report (Requirement 11.1): numbers are computed deterministically; the analyst only
// writes a short summary on top of them.
import type { AgentContext } from '@arlo/agents';
import {
  addDays,
  dateInTimeZone,
  deriveMetrics,
  forecastMonthSpend,
  formatChange,
  formatMoney,
  formatNumber,
  formatPct,
  type ChatMessage,
  type Section,
} from '@arlo/core';
import { dailySpend, listCampaigns, queryMetrics, type AdAccount, type Db, type MetricsRow } from '@arlo/db';
import { run } from '@openai/agents';
import type { TemplateContext, TemplateHandler } from '../types';

export interface AccountDayReport {
  account: { id: string; name: string; currency: string };
  date: string;
  yesterday: MetricsRow;
  dayBefore: MetricsRow;
  sameDayLastWeek: MetricsRow;
  campaigns: MetricsRow[];
  pacing: ReturnType<typeof forecastMonthSpend>;
  enabledBudgetMicros: number;
}

const total = async (db: Db, account: AdAccount, date: string) =>
  (await queryMetrics(db, { accountIds: [account.id], level: 'account', from: date, to: date, groupBy: 'total' }))[0]!;

export async function collectAccountDay(db: Db, account: AdAccount, now: Date): Promise<AccountDayReport> {
  const today = dateInTimeZone(now, account.timezone);
  const date = addDays(today, -1);
  const [yesterday, dayBefore, sameDayLastWeek, campaigns, history, budgets] = await Promise.all([
    total(db, account, date),
    total(db, account, addDays(date, -1)),
    total(db, account, addDays(date, -7)),
    queryMetrics(db, { accountIds: [account.id], level: 'campaign', from: date, to: date, groupBy: 'entity', limit: 10 }),
    dailySpend(db, [account.id], addDays(today, -35), today),
    listCampaigns(db, [account.id]),
  ]);
  const enabledBudgetMicros = budgets.filter((c) => c.status === 'ENABLED').reduce((s, c) => s + (c.budgetMicros ?? 0), 0);
  return {
    account: { id: account.id, name: account.name, currency: account.currency },
    date,
    yesterday,
    dayBefore,
    sameDayLastWeek,
    campaigns,
    pacing: forecastMonthSpend({ today, history, dailyBudgetMicros: enabledBudgetMicros || null }),
    enabledBudgetMicros,
  };
}

export function accountSections(r: AccountDayReport): Section[] {
  const cur = r.account.currency;
  const y = deriveMetrics(r.yesterday);
  return [
    {
      kind: 'fields',
      heading: `${r.account.name} · ${r.date}`,
      fields: [
        { label: '花費', value: `${formatMoney(r.yesterday.costMicros, cur)}（前日 ${formatChange(r.dayBefore.costMicros, r.yesterday.costMicros)}，上週同日 ${formatChange(r.sameDayLastWeek.costMicros, r.yesterday.costMicros)}）` },
        { label: '轉換', value: `${formatNumber(r.yesterday.conversions, 1)}（前日 ${formatChange(r.dayBefore.conversions, r.yesterday.conversions)}）` },
        { label: 'CPA', value: formatMoney(y.cpaMicros, cur) },
        { label: 'ROAS', value: y.roas === null ? '—' : formatNumber(y.roas, 2) },
        { label: 'CTR', value: formatPct(y.ctr, 2) },
        { label: 'CPC', value: formatMoney(y.cpcMicros, cur) },
        { label: '本月至今', value: formatMoney(r.pacing.mtdMicros, cur) },
        { label: '月底預測', value: `${formatMoney(r.pacing.projectedMicros, cur)}${r.pacing.budgetPace === null ? '' : `（預算 pace ${formatPct(r.pacing.budgetPace, 0)}）`}` },
      ],
    },
    {
      kind: 'table',
      columns: ['Campaign', '花費', '轉換', 'CPA', 'ROAS', 'IS'],
      rows: r.campaigns.map((c) => {
        const d = deriveMetrics(c);
        return [c.entityName ?? '—', formatMoney(c.costMicros, cur), formatNumber(c.conversions, 1), formatMoney(d.cpaMicros, cur), d.roas === null ? '—' : formatNumber(d.roas, 2), formatPct(c.searchIs, 0)];
      }),
    },
  ];
}

/** Compact JSON of the numbers for the analyst to summarize. */
export function summaryInput(reports: AccountDayReport[]): string {
  return JSON.stringify(
    reports.map((r) => ({
      account: r.account.name,
      currency: r.account.currency,
      date: r.date,
      yesterday: { cost: r.yesterday.costMicros / 1e6, conversions: r.yesterday.conversions, ...deriveMetrics(r.yesterday) },
      dayBefore: { cost: r.dayBefore.costMicros / 1e6, conversions: r.dayBefore.conversions },
      sameDayLastWeek: { cost: r.sameDayLastWeek.costMicros / 1e6, conversions: r.sameDayLastWeek.conversions },
      monthToDate: r.pacing.mtdMicros / 1e6,
      projectedMonth: r.pacing.projectedMicros / 1e6,
      budgetPace: r.pacing.budgetPace,
      campaigns: r.campaigns.map((c) => ({ name: c.entityName, cost: c.costMicros / 1e6, conversions: c.conversions, ...deriveMetrics(c) })),
    })),
  );
}

async function writeSummary(ctx: TemplateContext, reports: AccountDayReport[]): Promise<{ text: string | null; traceId: string | null }> {
  const prompt = [
    '以下是排程每日報告的數據（JSON，金額為帳戶幣別單位，cpcMicros / cpaMicros 為 micros）。',
    '請寫 3–5 點繁體中文重點摘要：花費與轉換的明顯變化、需要注意的 campaign、pacing 風險。數字只能取自資料，不要逐項重述表格。',
    ctx.job.extraInstructions ? `額外指示：${ctx.job.extraInstructions}` : '',
    '```json',
    summaryInput(reports),
    '```',
  ]
    .filter(Boolean)
    .join('\n');
  const context: AgentContext = { db: ctx.db, allowedAccountIds: reports.map((r) => r.account.id), now: ctx.now };
  try {
    const result = await run(ctx.agents.analyst(), prompt, { context, maxTurns: 6 });
    return { text: String(result.finalOutput ?? '').trim() || null, traceId: null };
  } catch (err) {
    ctx.logger.warn({ err }, 'daily report summary failed; sending numbers only');
    return { text: null, traceId: null };
  }
}

export const dailyReport: TemplateHandler = {
  critical: false,
  async run(ctx) {
    const reports = [];
    for (const account of ctx.accounts) reports.push(await collectAccountDay(ctx.db, account, ctx.now()));
    if (reports.length === 0) {
      return { messages: [{ type: 'notice', level: 'warn', text: `排程「${ctx.job.name}」沒有可報告的帳戶。` }], changesetIds: [] };
    }
    const summary = await writeSummary(ctx, reports);
    const message: ChatMessage = {
      type: 'report',
      title: `每日報告 · ${reports[0]!.date}`,
      sections: [
        { kind: 'text', text: summary.text ?? '_（摘要暫時無法產生，以下為數據）_' },
        ...reports.flatMap(accountSections),
      ],
    };
    return { messages: [message], changesetIds: [], traceId: summary.traceId };
  },
};
