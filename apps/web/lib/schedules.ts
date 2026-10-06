// Schedule management for the Web console (Requirements 11.2, 11.5, 18.4).
import { ConversationRefSchema } from '@arlo/core';
import { createScheduledJob, JOB_TEMPLATES, updateScheduledJob, type Db, type ScheduledJob } from '@arlo/db';
import { enqueue, Jobs, previewCron, type PgBoss } from '@arlo/queue';
import { z } from 'zod';

export const TEMPLATE_LABELS: Record<(typeof JOB_TEMPLATES)[number], string> = {
  daily_report: '每日報告',
  negative_kw_sweep: '否定關鍵字掃描',
  budget_rebalance: '預算再分配',
  tracking_audit: '追蹤審計',
  anomaly_watch: '異常監看',
  custom_prompt: '自訂指示',
};

export const ScheduleFormSchema = z
  .object({
    name: z.string().trim().min(1, '請輸入名稱').max(100),
    template: z.enum(JOB_TEMPLATES),
    cron: z.string().trim().min(1, '請輸入 cron'),
    tz: z.string().trim().min(1),
    /** Empty = every active account. */
    accountIds: z.array(z.uuid()),
    channelId: z.string().trim().regex(/^[A-Z0-9]+$/, '請選擇或輸入 Slack channel ID'),
    extraInstructions: z.string().trim().max(2000, '最多 2000 字').optional(),
    enabled: z.boolean(),
  })
  .superRefine((v, ctx) => {
    const preview = previewCron(v.cron, v.tz);
    if (!preview.ok) {
      const field = /time zone/i.test(preview.error) ? 'tz' : 'cron';
      ctx.addIssue({ code: 'custom', path: [field], message: field === 'tz' ? '無效的時區' : `無效的 cron：${preview.error}` });
    }
    if (v.template === 'custom_prompt' && !v.extraInstructions) {
      ctx.addIssue({ code: 'custom', path: ['extraInstructions'], message: 'custom_prompt 需要指示內容' });
    }
  });

export type ScheduleForm = z.infer<typeof ScheduleFormSchema>;
export type FieldErrors = Partial<Record<keyof ScheduleForm | 'form', string>>;

export function parseScheduleForm(form: FormData): { ok: true; value: ScheduleForm } | { ok: false; errors: FieldErrors } {
  const result = ScheduleFormSchema.safeParse({
    name: form.get('name'),
    template: form.get('template'),
    cron: form.get('cron'),
    tz: form.get('tz'),
    accountIds: form.getAll('accountIds').map(String).filter(Boolean),
    channelId: form.get('channelId'),
    extraInstructions: String(form.get('extraInstructions') ?? '') || undefined,
    enabled: form.get('enabled') === 'on',
  });
  if (result.success) return { ok: true, value: result.data };
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = (issue.path[0] ?? 'form') as keyof FieldErrors;
    errors[key] ??= issue.message;
  }
  return { ok: false, errors };
}

function toRow(v: ScheduleForm) {
  return {
    name: v.name,
    template: v.template,
    cron: v.cron,
    tz: v.tz,
    accountIds: v.accountIds.length ? v.accountIds : null,
    target: ConversationRefSchema.parse({ platform: 'slack', channelId: v.channelId }),
    extraInstructions: v.extraInstructions ?? null,
    enabled: v.enabled,
  };
}

/** Saves and asks the worker to re-sync pg-boss cron (scheduler.sync). */
export async function saveSchedule(db: Db, boss: PgBoss, input: { id?: string; value: ScheduleForm; userId: string }): Promise<ScheduledJob> {
  const row = input.id ? await updateScheduledJob(db, input.id, toRow(input.value)) : await createScheduledJob(db, { ...toRow(input.value), createdBy: input.userId });
  if (!row) throw new Error('schedule not found');
  await enqueue(boss, Jobs.schedulerSync, {});
  return row;
}

export async function setScheduleEnabled(db: Db, boss: PgBoss, id: string, enabled: boolean): Promise<void> {
  if (!(await updateScheduledJob(db, id, { enabled }))) throw new Error('schedule not found');
  await enqueue(boss, Jobs.schedulerSync, {});
}

/** Manual run (Requirement 11.5); runs even when the schedule is disabled. */
export function triggerSchedule(boss: PgBoss, id: string): Promise<string> {
  return enqueue(boss, Jobs.schedulerRun, { scheduledJobId: id, trigger: 'manual' });
}
