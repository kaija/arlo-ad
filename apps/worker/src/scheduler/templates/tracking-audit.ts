// tracking_audit (ADR-0021, Requirements 16.1–16.3): daily conversion tracking health and the
// GA4 vs Ads gap. Deterministic, so it runs even when the LLM budget is spent.
import { addDays, assessTracking, dateInTimeZone, ga4Gap, type ConversionActionHealthInput, type Section } from '@arlo/core';
import { conversionGapSeries, listConversionActions } from '@arlo/db';
import type { TemplateHandler } from '../types';

const ICON = { ok: ':white_check_mark:', warn: ':warning:', critical: ':rotating_light:' } as const;

export const trackingAudit: TemplateHandler = {
  critical: true,
  async run(ctx) {
    const now = ctx.now();
    const sections: Section[] = [];
    let worst: 'ok' | 'warn' | 'critical' = 'ok';
    for (const account of ctx.accounts) {
      const today = dateInTimeZone(now, account.timezone);
      const actions = await listConversionActions(ctx.db, account.id);
      const health = assessTracking(
        actions.map((a) => ({ ...a, ecDiagnostics: (a.ecDiagnostics ?? null) as ConversionActionHealthInput['ecDiagnostics'] })),
        now,
      );
      const gap = account.ga4PropertyId ? ga4Gap(await conversionGapSeries(ctx.db, account, addDays(today, -17), addDays(today, -1))) : null;
      const status = gap?.alert && health.status === 'ok' ? 'warn' : health.status;
      if (status === 'critical' || (status === 'warn' && worst === 'ok')) worst = status;
      const lines = [
        ...(health.noPrimary ? ['• 沒有啟用中的主要轉換動作：出價沒有目標可優化'] : []),
        ...health.actions.flatMap((a) => a.issues.map((i) => `• ${a.name}：${i.message}`)),
        gap ? `• GA4：${gap.reason}` : '• GA4：未連結 property，略過落差檢查',
      ];
      const healthy = health.actions.filter((a) => a.status === 'ok').length;
      sections.push({ kind: 'text', heading: `${ICON[status]} ${account.name}`, text: [`${healthy}/${health.actions.length} 個轉換動作正常`, ...lines].join('\n') });
    }
    if (sections.length === 0) return { messages: [{ type: 'notice', level: 'warn', text: `排程「${ctx.job.name}」沒有可檢查的帳戶。` }], changesetIds: [] };
    return {
      messages: [
        ...(worst === 'critical' ? [{ type: 'notice' as const, level: 'error' as const, text: '轉換追蹤疑似失效，請檢查下方帳戶（出價會因少報轉換而失準）。' }] : []),
        { type: 'report', title: `轉換追蹤檢查 · ${dateInTimeZone(now, ctx.accounts[0]!.timezone)}`, sections },
      ],
      changesetIds: [],
    };
  },
};
