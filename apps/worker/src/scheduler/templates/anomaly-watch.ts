// anomaly_watch (ADR-0021, Requirements 16.4, 16.5): robust-z detection on yesterday's metrics for
// the account and its top campaigns, plus clicks-vs-GA4-sessions; each new anomaly gets its likely
// causes ranked from the changes within ±48h (model when available, else by time and target).
import { causeRankerInput, validCauses, type CauseRanking } from '@arlo/agents';
import { addDays, clicksWithoutSessions, dateInTimeZone, detectMetricAnomalies, formatNumber, type Anomaly, type DailyPoint, type Section } from '@arlo/core';
import { changesAround, conversionGapSeries, findEntities, queryMetrics, saveAnomalies, setAnomalyExplanation, type AdAccount, type AnomalyRow, type CauseCandidate } from '@arlo/db';
import { run } from '@openai/agents';
import type { TemplateContext, TemplateHandler } from '../types';

export const WATCH_TOP_CAMPAIGNS = 10;
const HISTORY_DAYS = 28;

const METRIC_LABEL: Record<string, string> = { clicks: '點擊', ctr: 'CTR', cpc: 'CPC', cvr: '轉換率', cost: '花費', conversions: '轉換', clicks_vs_sessions: '點擊↑ 但 GA4 工作階段持平' };

const toPoints = (rows: { date: string | null; impressions: number; clicks: number; costMicros: number; conversions: number }[]): DailyPoint[] =>
  rows.filter((r) => r.date).map((r) => ({ date: r.date!, impressions: r.impressions, clicks: r.clicks, costMicros: r.costMicros, conversions: r.conversions }));

/** Without a model: causes touching the anomaly's entity first, then the closest in time before it. */
export function proximityRanking(anomalyDate: string, entityExternalId: string | null, candidates: readonly CauseCandidate[]): CauseRanking['causes'] {
  const at = new Date(`${anomalyDate}T12:00:00Z`).getTime();
  return [...candidates]
    .filter((c) => c.at.getTime() <= at + 24 * 3_600_000)
    .sort((a, b) => {
      const ta = entityExternalId && a.targets.includes(entityExternalId) ? 0 : 1;
      const tb = entityExternalId && b.targets.includes(entityExternalId) ? 0 : 1;
      return ta - tb || Math.abs(at - a.at.getTime()) - Math.abs(at - b.at.getTime());
    })
    .slice(0, 3)
    .map((c, i) => ({ id: c.id, likelihood: Math.round((0.6 - i * 0.15) * 100) / 100, reason: '時間最接近的變更（自動排序，未經 AI 分析）' }));
}

async function explain(ctx: TemplateContext, account: AdAccount, row: AnomalyRow, entityExternalId: string | null): Promise<string> {
  const candidates = await changesAround(ctx.db, account.id, new Date(`${row.detectedOn}T12:00:00Z`));
  let causes: CauseRanking['causes'] = [];
  let summary: string | null = null;
  if (candidates.length && ctx.agents.causeRanker) {
    try {
      const result = await run(
        ctx.agents.causeRanker(),
        causeRankerInput(
          { date: row.detectedOn, metric: row.metric, direction: row.direction as 'up' | 'down', value: row.value, baseline: row.baseline, entity: entityExternalId },
          candidates.map((c) => ({ id: c.id, at: c.at.toISOString(), kind: c.kind, who: c.who, summary: c.summary, targets: c.targets })),
        ),
        { maxTurns: 1 },
      );
      const ranking = result.finalOutput as CauseRanking;
      causes = validCauses(ranking, candidates);
      summary = ranking.summary;
    } catch (err) {
      ctx.logger.warn({ err, anomaly_id: row.id }, 'cause ranking failed; ranking by proximity');
    }
  }
  if (!summary) causes = proximityRanking(row.detectedOn, entityExternalId, candidates);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const lines = causes.map((c, i) => {
    const cand = byId.get(c.id)!;
    return `${i + 1}. ${cand.summary}（${cand.who ?? '未知'}，${cand.at.toISOString().slice(0, 16).replace('T', ' ')}Z，可能性 ${Math.round(c.likelihood * 100)}%）${c.reason ? `：${c.reason}` : ''}`;
  });
  return [summary ?? (causes.length ? '可能原因（依時間與影響範圍排序）：' : '前後 48 小時沒有相關變更，可能是外部因素（季節、競爭、追蹤）。'), ...lines].join('\n');
}

export const anomalyWatch: TemplateHandler = {
  critical: false,
  async run(ctx) {
    const sections: Section[] = [];
    for (const account of ctx.accounts) {
      const today = dateInTimeZone(ctx.now(), account.timezone);
      const yesterday = addDays(today, -1);
      const from = addDays(yesterday, -HISTORY_DAYS);
      const found: { row: AnomalyRow; label: string; entityExternalId: string | null }[] = [];

      const accountSeries = toPoints(await queryMetrics(ctx.db, { accountIds: [account.id], level: 'account', from, to: yesterday, groupBy: 'day' }));
      for (const row of await saveAnomalies(ctx.db, account.id, null, detectMetricAnomalies(accountSeries))) found.push({ row, label: account.name, entityExternalId: null });

      const top = await queryMetrics(ctx.db, { accountIds: [account.id], level: 'campaign', from: addDays(yesterday, -6), to: yesterday, groupBy: 'entity', limit: WATCH_TOP_CAMPAIGNS });
      for (const c of top) {
        const series = toPoints(await queryMetrics(ctx.db, { accountIds: [account.id], level: 'campaign', from, to: yesterday, entityIds: [c.entityId!], groupBy: 'day' }));
        const detected: Anomaly[] = detectMetricAnomalies(series);
        const [entity] = await findEntities(ctx.db, [account.id], 'campaign', [c.entityId!]);
        for (const row of await saveAnomalies(ctx.db, account.id, c.entityId, detected)) found.push({ row, label: c.entityName ?? account.name, entityExternalId: entity?.externalId ?? null });
      }

      if (account.ga4PropertyId) {
        const gap = await conversionGapSeries(ctx.db, account, from, yesterday);
        const mismatch = clicksWithoutSessions(gap);
        if (mismatch) for (const row of await saveAnomalies(ctx.db, account.id, null, [mismatch])) found.push({ row, label: account.name, entityExternalId: null });
      }

      const lines: string[] = [];
      for (const f of found) {
        const explanation = f.row.explanation ?? (await explain(ctx, account, f.row, f.entityExternalId));
        if (!f.row.explanation) await setAnomalyExplanation(ctx.db, f.row.id, explanation, ctx.now());
        const dir = f.row.direction === 'up' ? '↑' : '↓';
        lines.push(`*${f.label} · ${METRIC_LABEL[f.row.metric] ?? f.row.metric} ${dir}*（${formatNumber(f.row.value, 2)}，基準 ${formatNumber(f.row.baseline, 2)}，z=${f.row.z.toFixed(1)}）\n${explanation}`);
      }
      sections.push({ kind: 'text', heading: account.name, text: lines.length ? lines.join('\n\n') : `${yesterday} 沒有偵測到異常。` });
    }
    if (sections.length === 0) return { messages: [{ type: 'notice', level: 'warn', text: `排程「${ctx.job.name}」沒有可檢查的帳戶。` }], changesetIds: [] };
    return { messages: [{ type: 'report', title: '異常偵測', sections }], changesetIds: [] };
  },
};
