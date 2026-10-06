// Slack interactivity → Executor (ADR-0010, Requirements 1.5, 1.6, 6.6). The Slack user is
// resolved to an internal user, `authorize` decides, the Executor's CAS makes clicks idempotent.
import type { ChatAdapter, ConfirmMetadata } from '@arlo/adapters/chat';
import type { Logger } from '@arlo/config/logger';
import { authorize, decodeAction, type ChatAction, type ConversationRef } from '@arlo/core';
import { getChangeSet, recordShadowFeedback, resolveSlackUser, type Db, type UserWithBindings } from '@arlo/db';
import { defineJob, Jobs, type JobData } from '@arlo/queue';
import { decide, DISABLED, UNBOUND } from './decisions';
import type { Executor } from './executor';

export interface InteractionDeps {
  db: Db;
  chat: ChatAdapter;
  logger: Logger;
  executor: Executor;
}

type Interaction = JobData<typeof Jobs.chatInteraction>;

function confirmMetadata(raw: string): ConfirmMetadata | null {
  try {
    const m = JSON.parse(raw) as Partial<ConfirmMetadata>;
    return typeof m?.changesetId === 'string' ? { changesetId: m.changesetId, channelId: typeof m.channelId === 'string' ? m.channelId : undefined, threadId: typeof m.threadId === 'string' ? m.threadId : undefined } : null;
  } catch {
    return null;
  }
}

export function createInteractionHandler(deps: InteractionDeps) {
  const { db, chat, executor } = deps;

  async function changesetAction(job: Interaction, user: UserWithBindings, action: Extract<ChatAction, { kind: 'changeset' }>, where: ConversationRef | null) {
    if (action.verb === 'keep') return;
    const { message } = await decide({ db, executor }, user, action.verb, action.changesetId);
    if (!message) return;
    if (where) await chat.ephemeral(where, job.userId, message);
    else deps.logger.info({ changeset_id: action.changesetId }, `no channel for feedback: ${message}`);
  }

  /** 👍/👎 on a ShadowResult card from anyone who can see the account (Requirement 9.4). */
  async function shadowVote(job: Interaction, user: UserWithBindings, action: Extract<ChatAction, { kind: 'shadow' }>, where: ConversationRef | null) {
    const say = (text: string) => (where ? chat.ephemeral(where, job.userId, text) : Promise.resolve());
    const cs = await getChangeSet(db, action.changesetId);
    if (!cs || cs.status !== 'SIMULATED') return say('這不是 shadow 模式的變更。');
    if (!authorize(user, 'view', { accountId: cs.accountId }).allowed) return say('你沒有這個廣告帳戶的權限。');
    const totals = await recordShadowFeedback(db, cs.id, user.id, action.verdict);
    await executor.refreshShadowCards(cs, totals);
  }

  return async function handleInteraction(job: Interaction): Promise<void> {
    let where: ConversationRef | null = null;
    let actions: ChatAction[] = [];
    if (job.type === 'block_actions' && job.channelId) {
      where = { platform: 'slack', channelId: job.channelId, ...(job.threadTs ? { threadId: job.threadTs } : {}) };
      actions = (job.actions ?? []).map((a) => decodeAction(a.actionId)).filter((a): a is ChatAction => a !== null);
    } else if (job.type === 'view_submission' && job.view) {
      const confirm = decodeAction(job.view.callbackId);
      if (confirm?.kind !== 'changeset' || confirm.verb !== 'confirm') return;
      const meta = confirmMetadata(job.view.privateMetadata);
      if (meta?.changesetId !== confirm.changesetId) return;
      where = meta.channelId ? { platform: 'slack', channelId: meta.channelId, ...(meta.threadId ? { threadId: meta.threadId } : {}) } : null;
      actions = [confirm];
    }
    if (actions.length === 0) return;

    const resolved = await resolveSlackUser(db, job.userId);
    if (!resolved.ok) {
      if (where) await chat.ephemeral(where, job.userId, resolved.reason === 'disabled' ? DISABLED : UNBOUND);
      return;
    }
    for (const action of actions) {
      if (action.kind === 'changeset') await changesetAction(job, resolved.user, action, where);
      if (action.kind === 'shadow') await shadowVote(job, resolved.user, action, where);
    }
  };
}

export function interactionJobs(deps: InteractionDeps) {
  const handle = createInteractionHandler(deps);
  return [defineJob(Jobs.chatInteraction, (data) => handle(data), { pollingIntervalSeconds: 0.5, concurrency: 4 })];
}
