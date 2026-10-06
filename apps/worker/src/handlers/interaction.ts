// Slack interactivity → Executor (ADR-0010, Requirements 1.5, 1.6, 6.6). The Slack user is
// resolved to an internal user, `authorize` decides, the Executor's CAS makes clicks idempotent.
import type { ChatAdapter } from '@arlo/adapters/chat';
import type { Logger } from '@arlo/config/logger';
import { authorize, decodeAction, type ChangeSetStatus, type ChatAction, type ConversationRef, type DenyReason } from '@arlo/core';
import { getChangeSet, resolveSlackUser, type Db, type UserWithBindings } from '@arlo/db';
import { defineJob, Jobs, type JobData } from '@arlo/queue';
import type { Executor } from './executor';

export interface InteractionDeps {
  db: Db;
  chat: ChatAdapter;
  logger: Logger;
  executor: Executor;
}

type Interaction = JobData<typeof Jobs.chatInteraction>;

const UNBOUND = '你的 Slack 帳號尚未對應到 Arlo 使用者，請先登入 Web console 或請 admin 協助綁定。';
const DISABLED = '你的 Arlo 帳號已停用。';

export const DENY_TEXT: Record<DenyReason, (tier: number | null) => string> = {
  disabled: () => DISABLED,
  role: () => '你沒有審核變更的權限。',
  scope: () => '你沒有這個廣告帳戶的權限。',
  tier: (tier) => `你的審核權限不足以核准 Tier ${tier ?? '?'} 的變更。`,
  four_eyes: () => 'Tier 3 變更不能由提出者本人核准，請另一位 approver 處理。',
  missing_target: () => '找不到這個變更。',
};

const STATUS_TEXT: Partial<Record<ChangeSetStatus, string>> = {
  APPROVED: '核准中',
  EXECUTING: '執行中',
  EXECUTED: '已執行',
  FAILED: '執行失敗',
  REJECTED: '已拒絕',
  EXPIRED: '已逾期',
  STALE: '已過時',
  BLOCKED: '已擋下',
  REVERTED: '已復原',
  SIMULATED: '已模擬',
};

export function alreadyHandled(status: ChangeSetStatus | null, by?: string | null): string {
  const what = (status && STATUS_TEXT[status]) ?? status ?? '已處理';
  return by ? `這個變更已由 ${by} 處理（${what}）。` : `這個變更已處理（${what}）。`;
}

export function createInteractionHandler(deps: InteractionDeps) {
  const { db, chat, executor } = deps;

  async function changesetAction(job: Interaction, user: UserWithBindings, action: Extract<ChatAction, { kind: 'changeset' }>, where: ConversationRef) {
    const say = (text: string) => chat.ephemeral(where, job.userId, text);
    const cs = await getChangeSet(db, action.changesetId);
    if (!cs) return say(DENY_TEXT.missing_target(null));

    if (action.verb === 'approve' || action.verb === 'reject') {
      const decision = authorize(user, action.verb, { accountId: cs.accountId, tier: cs.tier, requestedByUserId: cs.requestedBy.userId });
      if (!decision.allowed) return say(DENY_TEXT[decision.reason](cs.tier));
      if (action.verb === 'approve') {
        const result = await executor.approve(cs.id, user.id);
        if (result.outcome === 'not_pending' || result.outcome === 'not_found') return say(alreadyHandled(result.status, result.handledBy));
        if (result.outcome === 'expired') return say('這個變更已超過審核期限，未執行。');
        return;
      }
      const result = await executor.reject(cs.id, user.id);
      if (!result.ok) return say(alreadyHandled(result.status, result.handledBy));
      return;
    }
    deps.logger.info({ verb: action.verb, changeset_id: cs.id }, 'changeset action not handled yet');
  }

  return async function handleInteraction(job: Interaction): Promise<void> {
    if (job.type !== 'block_actions' || !job.channelId) return;
    const where: ConversationRef = { platform: 'slack', channelId: job.channelId, ...(job.threadTs ? { threadId: job.threadTs } : {}) };
    const actions = (job.actions ?? []).map((a) => decodeAction(a.actionId)).filter((a): a is ChatAction => a !== null);
    if (actions.length === 0) return;

    const resolved = await resolveSlackUser(db, job.userId);
    if (!resolved.ok) {
      await chat.ephemeral(where, job.userId, resolved.reason === 'disabled' ? DISABLED : UNBOUND);
      return;
    }
    for (const action of actions) {
      if (action.kind === 'changeset') await changesetAction(job, resolved.user, action, where);
    }
  };
}

export function interactionJobs(deps: InteractionDeps) {
  const handle = createInteractionHandler(deps);
  return [defineJob(Jobs.chatInteraction, (data) => handle(data), { pollingIntervalSeconds: 0.5, concurrency: 4 })];
}
