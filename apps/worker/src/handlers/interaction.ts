// Slack interactivity → Executor (ADR-0010, Requirements 1.5, 1.6, 6.6). The Slack user is
// resolved to an internal user, `authorize` decides, the Executor's CAS makes clicks idempotent.
import type { ChatAdapter, ConfirmMetadata } from '@arlo/adapters/chat';
import type { Logger } from '@arlo/config/logger';
import { authorize, decodeAction, type ChangeSetStatus, type ChatAction, type ConversationRef, type DenyReason } from '@arlo/core';
import { getChangeSet, resolveSlackUser, type Db, type UserWithBindings } from '@arlo/db';
import { defineJob, Jobs, type JobData } from '@arlo/queue';
import type { Executor, UndoResult } from './executor';

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

export function undoRefusal(result: Extract<UndoResult, { ok: false }>): string {
  switch (result.reason) {
    case 'forbidden':
      return 'Undo 需要 operator 以上、且涵蓋這個帳戶的權限。';
    case 'not_executed':
      return '這個變更目前不是已執行狀態，無法還原。';
    case 'window_passed':
      return '已超過 24 小時的 Undo 時限，請改為提出新的變更。';
    case 'not_revertible':
      return '這類新增型變更目前無法一鍵還原，請改為提出新的變更。';
    case 'drift': {
      const now = (result.drifts ?? []).map((d) => `op ${d.opIndex + 1}：${d.field} 現在是 ${String(d.actual ?? '（已不存在）')}，不是當初寫入的 ${String(d.expected)}`).join('\n');
      return `目標在執行後已被修改${result.lastModifiedBy ? `（最後修改者：${result.lastModifiedBy}）` : ''}，為避免覆蓋，未執行 Undo。\n${now}`;
    }
    case 'in_progress':
      return '這個變更已在還原中或已還原。';
    case 'failed':
      return '還原寫入失敗，請查看通知中的錯誤。';
    case 'not_found':
      return '找不到這個變更。';
  }
}

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
    const say = async (text: string) => {
      if (where) await chat.ephemeral(where, job.userId, text);
      else deps.logger.info({ changeset_id: action.changesetId }, `no channel for feedback: ${text}`);
    };
    const cs = await getChangeSet(db, action.changesetId);
    if (!cs) return say(DENY_TEXT.missing_target(null));

    if (action.verb === 'approve' || action.verb === 'reject' || action.verb === 'confirm') {
      const verb = action.verb === 'reject' ? 'reject' : 'approve';
      const decision = authorize(user, verb, { accountId: cs.accountId, tier: cs.tier, requestedByUserId: cs.requestedBy.userId });
      if (!decision.allowed) return say(DENY_TEXT[decision.reason](cs.tier));
      // Tier 3 is approved only through the confirm modal the web route opened (Requirement 4.4).
      if (action.verb === 'approve' && cs.tier === 3 && cs.status === 'PENDING_APPROVAL') return;
      if (verb === 'approve') {
        const result = await executor.approve(cs.id, user.id);
        if (result.outcome === 'not_pending' || result.outcome === 'not_found') return say(alreadyHandled(result.status, result.handledBy));
        if (result.outcome === 'expired') return say('這個變更已超過審核期限，未執行。');
        return;
      }
      const result = await executor.reject(cs.id, user.id);
      if (!result.ok) return say(alreadyHandled(result.status, result.handledBy));
      return;
    }
    if (action.verb === 'undo') {
      const result = await executor.undo(cs.id, user.id);
      if (!result.ok) return say(undoRefusal(result));
      return;
    }
    deps.logger.info({ verb: action.verb, changeset_id: cs.id }, 'changeset action not handled yet');
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
    }
  };
}

export function interactionJobs(deps: InteractionDeps) {
  const handle = createInteractionHandler(deps);
  return [defineJob(Jobs.chatInteraction, (data) => handle(data), { pollingIntervalSeconds: 0.5, concurrency: 4 })];
}
