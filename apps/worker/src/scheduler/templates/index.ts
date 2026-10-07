import type { JobRun } from '@arlo/db';
import type { TemplateHandler } from '../types';
import { anomalyWatch } from './anomaly-watch';
import { budgetRebalance } from './budget-rebalance';
import { customPrompt } from './custom-prompt';
import { dailyReport } from './daily-report';
import { negativeKwSweep } from './negative-kw-sweep';
import { trackingAudit } from './tracking-audit';

export const TEMPLATES: Partial<Record<JobRun['template'], TemplateHandler>> = {
  daily_report: dailyReport,
  custom_prompt: customPrompt,
  negative_kw_sweep: negativeKwSweep,
  tracking_audit: trackingAudit,
  anomaly_watch: anomalyWatch,
  budget_rebalance: budgetRebalance,
};
