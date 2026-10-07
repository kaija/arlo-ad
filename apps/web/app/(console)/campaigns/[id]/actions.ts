'use server';

import { authorize, DRAFT_SECTIONS, lintStructure, type DraftSection } from '@arlo/core';
import { getCampaignDraftVersion, getCampaignTask, saveCampaignDraft } from '@arlo/db';
import { Jobs } from '@arlo/queue';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { draftFromForm } from '../../../../lib/campaign-draft';
import { enqueueJob } from '../../../../lib/queue';
import { getDb } from '../../../../lib/server';
import { ForbiddenError, requireUser } from '../../../../lib/session';

/** The task, if the user may edit it (operator on its account, still a draft). */
async function editable(taskId: string) {
  const user = await requireUser();
  const task = /^[0-9a-f-]{36}$/i.test(taskId) ? await getCampaignTask(getDb(), taskId) : undefined;
  if (!task || !authorize(user, 'propose', { accountId: task.accountId }).allowed) throw new ForbiddenError('not_allowed');
  if (task.status !== 'draft') redirect(`/campaigns/${taskId}?error=${encodeURIComponent('只有草稿狀態可以修改')}`);
  return { user, task };
}

const back = (taskId: string, query: string): never => {
  revalidatePath(`/campaigns/${taskId}`);
  redirect(`/campaigns/${taskId}?${query}`);
};

// Every save is a new version (Requirement 15.4); lint issues are stored and shown, not blocking.
export async function saveDraftAction(taskId: string, form: FormData): Promise<void> {
  const { user, task } = await editable(taskId);
  const parsed = draftFromForm(form);
  if (!parsed.ok) back(taskId, `error=${encodeURIComponent(parsed.error)}`);
  const draft = (parsed as Extract<typeof parsed, { ok: true }>).draft;
  const saved = await saveCampaignDraft(getDb(), { taskId, draft, lintIssues: lintStructure(draft, { landingPageUrl: task.brief.landingPageUrl }), origin: 'edit', createdBy: user.id });
  back(taskId, `saved=${saved.version}`);
}

export async function regenerateAction(taskId: string, form: FormData): Promise<void> {
  const { user } = await editable(taskId);
  const section = String(form.get('section') ?? '') as DraftSection;
  if (!(DRAFT_SECTIONS as readonly string[]).includes(section)) back(taskId, `error=${encodeURIComponent('請選擇區段')}`);
  const instructions = String(form.get('instructions') ?? '').trim().slice(0, 1000) || null;
  await enqueueJob(Jobs.campaignRegenerate, { taskId, section, instructions, userId: user.id });
  back(taskId, 'regenerating=1');
}

/** Restoring copies an older version into a new one, so history is never rewritten. */
export async function restoreVersionAction(taskId: string, version: number): Promise<void> {
  const { user, task } = await editable(taskId);
  const db = getDb();
  const old = await getCampaignDraftVersion(db, taskId, version);
  if (!old) back(taskId, `error=${encodeURIComponent('找不到版本')}`);
  const draft = old!.draft;
  const saved = await saveCampaignDraft(db, { taskId, draft, lintIssues: lintStructure(draft, { landingPageUrl: task.brief.landingPageUrl }), origin: `restore:${version}`, createdBy: user.id });
  back(taskId, `saved=${saved.version}`);
}
