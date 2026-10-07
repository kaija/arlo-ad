// Audit-domain read tools (ADR-0021): tracking health, GA4 gap, anomalies, nearby changes.
import { addDays, assessTracking, dateInTimeZone, ga4Gap, isIsoDate, type ConversionActionHealthInput } from '@arlo/core';
import { changesAround, conversionGapSeries, listAnomalies, listConversionActions, resolveAccounts, type AdAccount } from '@arlo/db';
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

const accountParam = z.string().describe('帳戶名稱或 Google Ads customer ID');

export const GetTrackingHealthParams = z.object({ account: accountParam });

/** Conversion action health plus the GA4 gap, as the daily tracking audit computes them. */
export async function runGetTrackingHealth(ctx: AgentContext, p: z.infer<typeof GetTrackingHealthParams>) {
  const acc = await oneAccount(ctx, p.account);
  const now = ctx.now();
  const today = dateInTimeZone(now, acc.timezone);
  const actions = await listConversionActions(ctx.db, acc.id);
  const health = assessTracking(
    actions.map((a) => ({ ...a, ecDiagnostics: (a.ecDiagnostics ?? null) as ConversionActionHealthInput['ecDiagnostics'] })),
    now,
  );
  const gap = acc.ga4PropertyId ? ga4Gap(await conversionGapSeries(ctx.db, acc, addDays(today, -17), addDays(today, -1))) : null;
  return {
    account: acc.name,
    status: health.status,
    noPrimaryAction: health.noPrimary,
    actions: health.actions.map((a) => ({ name: a.name, status: a.status, issues: a.issues.map((i) => i.message), dailyAverage: Math.round(a.dailyAverage * 10) / 10, hoursSinceLast: a.hoursSinceLast === null ? null : Math.round(a.hoursSinceLast) })),
    ga4: gap ? { alert: gap.alert, summary: gap.reason, baselineRatio: gap.baselineRatio, recentRatio: gap.recentRatio } : { note: '帳戶未連結 GA4 property' },
  };
}

export const GetAnomaliesParams = z.object({ account: accountParam, days: z.number().int().min(1).max(60).nullable().describe('最近幾天，預設 7') });

export async function runGetAnomalies(ctx: AgentContext, p: z.infer<typeof GetAnomaliesParams>) {
  const acc = await oneAccount(ctx, p.account);
  const since = addDays(dateInTimeZone(ctx.now(), acc.timezone), -(p.days ?? 7));
  const rows = await listAnomalies(ctx.db, { accountIds: [acc.id], since, limit: 50 });
  return {
    account: acc.name,
    anomalies: rows.map((r) => ({ date: r.detectedOn, metric: r.metric, segment: r.segment || null, direction: r.direction, value: r.value, baseline: r.baseline, z: r.z, explanation: r.explanation })),
  };
}

export const GetChangesAroundParams = z.object({
  account: accountParam,
  date: z.string().describe('異常日期 YYYY-MM-DD（帳戶時區）'),
  hours: z.number().int().min(1).max(72).nullable().describe('前後幾小時，預設 48'),
});

export async function runGetChangesAround(ctx: AgentContext, p: z.infer<typeof GetChangesAroundParams>) {
  if (!isIsoDate(p.date)) throw new ToolInputError('日期需為 YYYY-MM-DD。');
  const acc = await oneAccount(ctx, p.account);
  const noon = new Date(`${p.date}T12:00:00Z`);
  const candidates = await changesAround(ctx.db, acc.id, noon, p.hours ?? 48);
  return { account: acc.name, changes: candidates.map((c) => ({ id: c.id, at: c.at.toISOString(), kind: c.kind, who: c.who, summary: c.summary, targets: c.targets })) };
}

export const getTrackingHealthTool = tool({
  name: 'get_tracking_health',
  description: '轉換追蹤健康：各轉換動作狀態、最後轉換時間、上傳診斷，以及 GA4 與 Ads 轉換比的偏移。',
  parameters: GetTrackingHealthParams,
  execute: (p, rc?: RunContext<AgentContext>) => runGetTrackingHealth(ctxOf(rc), p),
});

export const getAnomaliesTool = tool({
  name: 'get_anomalies',
  description: '最近偵測到的成效異常（點擊、CTR、CPC、轉換率、點擊與 GA4 工作階段背離），含已有的原因說明。',
  parameters: GetAnomaliesParams,
  execute: (p, rc?: RunContext<AgentContext>) => runGetAnomalies(ctxOf(rc), p),
});

export const getChangesAroundTool = tool({
  name: 'get_changes_around',
  description: '某天前後 N 小時內的 Google Ads 變更紀錄與 Arlo 變更，用來找異常的可能原因。',
  parameters: GetChangesAroundParams,
  execute: (p, rc?: RunContext<AgentContext>) => runGetChangesAround(ctxOf(rc), p),
});
