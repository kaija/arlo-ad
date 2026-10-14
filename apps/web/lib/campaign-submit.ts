// Submitting a draft and enabling the created campaign (ADR-0020, Requirements 15.5, 15.6). Both
// are ChangeSets for the Executor; nothing here talks to Google Ads.
import { draftToBundle, type LintIssue, type Op } from '@arlo/core';
import {
  getAdAccount,
  insertChangeSet,
  latestCampaignDraft,
  listChangeSets,
  setCampaignTaskStatus,
  setDraftChangeSet,
  submittedDraft,
  type CampaignTask,
  type Db,
} from '@arlo/db';
import { enqueue, inTransaction, Jobs, type PgBoss } from '@arlo/queue';
import type { Msg } from './msg';

export type SubmitResult = { ok: true; changesetId: string } | { ok: false; error: Msg; issues?: LintIssue[] };

/** Latest draft → create_campaign_bundle ChangeSet (PAUSED, at least Tier 2); task → submitted. */
export async function submitDraft(db: Db, boss: PgBoss, task: CampaignTask, userId: string): Promise<SubmitResult> {
  if (task.status !== 'draft') return { ok: false, error: 'draftOnlySubmit' };
  const [draft, account] = await Promise.all([latestCampaignDraft(db, task.id), getAdAccount(db, task.accountId)]);
  if (!draft || !account) return { ok: false, error: 'draftNotFound' };
  const built = draftToBundle(draft.draft, { landingPageUrl: task.brief.landingPageUrl });
  if (!built.ok) return { ok: false, error: 'draftHasErrors', issues: built.issues };
  const op: Op = {
    kind: 'google.create_campaign_bundle',
    target: { platform: account.platform, accountId: account.externalId, kind: 'account', id: account.externalId },
    before: null,
    after: built.bundle,
    meta: { minTier: 2, taskId: task.id, draftVersion: draft.version },
  };
  return db.transaction(async (tx) => {
    // Claim the task first so a double submit creates one ChangeSet.
    const claimed = await setCampaignTaskStatus(tx, task.id, ['draft'], 'submitted');
    if (!claimed) return { ok: false as const, error: 'draftAlreadySubmitted' };
    const cs = await insertChangeSet(tx, {
      accountId: account.id,
      source: { kind: 'web' },
      ops: [op],
      summary: `建立 campaign「${built.bundle.name}」（暫停狀態）`,
      rationale: draft.draft.rationale,
      requestedBy: { kind: 'user', userId },
    });
    await setDraftChangeSet(tx, draft.id, cs.id);
    await enqueue(boss, Jobs.changesetProcess, { changesetId: cs.id }, inTransaction(tx));
    return { ok: true as const, changesetId: cs.id };
  });
}

export interface CreatedCampaign {
  changesetId: string;
  changesetStatus: string;
  campaignExternalId: string | null;
  /** An enable ChangeSet that is pending or done, if any. */
  enableChangesetId: string | null;
}

export async function createdCampaign(db: Db, task: CampaignTask): Promise<CreatedCampaign | null> {
  const s = await submittedDraft(db, task.id);
  if (!s) return null;
  let enableChangesetId: string | null = null;
  if (s.campaignExternalId) {
    const sets = await listChangeSets(db, { accountIds: [task.accountId], limit: 200 });
    enableChangesetId =
      sets.find(
        (cs) =>
          !['FAILED', 'REJECTED', 'EXPIRED', 'STALE', 'BLOCKED'].includes(cs.status) &&
          cs.ops.some((op) => op.kind === 'set_status' && op.target.kind === 'campaign' && op.target.id === s.campaignExternalId && op.after === 'ENABLED'),
      )?.id ?? null;
  }
  return { changesetId: s.draft.changesetId!, changesetStatus: s.changesetStatus, campaignExternalId: s.campaignExternalId, enableChangesetId };
}

/** Enabling the paused campaign is its own ChangeSet (Requirement 15.6). */
export async function enableCampaign(db: Db, boss: PgBoss, task: CampaignTask, userId: string): Promise<SubmitResult> {
  const created = await createdCampaign(db, task);
  if (!created || created.changesetStatus !== 'EXECUTED' || !created.campaignExternalId) return { ok: false, error: 'campaignNotCreated' };
  if (created.enableChangesetId) return { ok: false, error: 'enableAlreadyPending' };
  const account = await getAdAccount(db, task.accountId);
  if (!account) return { ok: false, error: 'accountNotFound' };
  return db.transaction(async (tx) => {
    const cs = await insertChangeSet(tx, {
      accountId: account.id,
      source: { kind: 'web' },
      ops: [{ kind: 'set_status', target: { platform: account.platform, accountId: account.externalId, kind: 'campaign', id: created.campaignExternalId! }, field: 'status', before: 'PAUSED', after: 'ENABLED' }],
      summary: `啟用 campaign「${task.brief.name}」`,
      requestedBy: { kind: 'user', userId },
    });
    await enqueue(boss, Jobs.changesetProcess, { changesetId: cs.id }, inTransaction(tx));
    return { ok: true as const, changesetId: cs.id };
  });
}
