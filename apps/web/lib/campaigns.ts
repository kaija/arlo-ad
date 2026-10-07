// Campaign briefs and tasks (ADR-0020, Requirements 15.1, 15.8).
import { CampaignBriefSchema, type CampaignBrief, type CampaignTaskStatus } from '@arlo/core';
import { createCampaignTask, type CampaignTask, type Db } from '@arlo/db';
import { enqueue, inTransaction, Jobs, type PgBoss } from '@arlo/queue';

export const TASK_STATUS_LABEL: Record<CampaignTaskStatus, string> = { queued: '排隊中', running: '產生中', draft: '草稿', submitted: '已送出', failed: '失敗' };
export const TASK_STATUS_TONE: Record<CampaignTaskStatus, 'neutral' | 'ok' | 'warn' | 'bad' | 'info'> = { queued: 'neutral', running: 'info', draft: 'warn', submitted: 'ok', failed: 'bad' };

export interface BriefFormValues {
  accountId: string;
  name: string;
  objective: string;
  offering: string;
  landingPageUrl: string;
  audience: string;
  locations: string;
  languages: string;
  dailyBudget: string;
  notes: string;
}

export type BriefFormErrors = Partial<Record<keyof BriefFormValues, string>>;

const list = (s: string) => s.split(/[,，、\n]/).map((x) => x.trim()).filter(Boolean);

export function briefFormValues(form: FormData): BriefFormValues {
  const g = (k: keyof BriefFormValues) => String(form.get(k) ?? '');
  return { accountId: g('accountId'), name: g('name'), objective: g('objective'), offering: g('offering'), landingPageUrl: g('landingPageUrl'), audience: g('audience'), locations: g('locations'), languages: g('languages'), dailyBudget: g('dailyBudget'), notes: g('notes') };
}

export function parseBriefForm(v: BriefFormValues, accounts: readonly string[]): { ok: true; accountId: string; brief: CampaignBrief } | { ok: false; errors: BriefFormErrors } {
  const errors: BriefFormErrors = {};
  if (!accounts.includes(v.accountId)) errors.accountId = '請選擇你可以提案的帳戶';
  const parsed = CampaignBriefSchema.safeParse({
    name: v.name,
    objective: v.objective,
    offering: v.offering,
    landingPageUrl: v.landingPageUrl.trim(),
    audience: v.audience.trim() || null,
    locations: list(v.locations),
    languages: list(v.languages),
    dailyBudget: Number(v.dailyBudget.replace(/,/g, '')),
    notes: v.notes.trim() || null,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]) as keyof BriefFormValues;
      errors[key] ??= key === 'landingPageUrl' ? '請輸入 https:// 開頭的網址' : key === 'dailyBudget' ? '請輸入正數金額' : key === 'locations' || key === 'languages' ? '至少一項' : '必填或太長';
    }
  }
  if (Object.keys(errors).length || !parsed.success) return { ok: false, errors };
  return { ok: true, accountId: v.accountId, brief: parsed.data };
}

/** Creates the task and queues campaign.generate in one transaction (Requirement 15.1). */
export function submitBrief(db: Db, boss: PgBoss, input: { accountId: string; brief: CampaignBrief; userId: string | null }): Promise<CampaignTask> {
  return db.transaction(async (tx) => {
    const task = await createCampaignTask(tx, { accountId: input.accountId, brief: input.brief, createdBy: input.userId });
    await enqueue(boss, Jobs.campaignGenerate, { taskId: task.id }, inTransaction(tx));
    return task;
  });
}
