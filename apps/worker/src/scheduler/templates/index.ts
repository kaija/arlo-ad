import type { JobRun } from '@arlo/db';
import type { TemplateHandler } from '../types';
import { dailyReport } from './daily-report';

export const TEMPLATES: Partial<Record<JobRun['template'], TemplateHandler>> = {
  daily_report: dailyReport,
};
