// One decision path for Slack and Web (Requirement 18.8): authorize the user against the
// ChangeSet, then call the Executor. Returns what to tell the user, if anything.
import { authorize, type ChangeSetStatus, type ChangeSetVerb, type DenyReason } from '@arlo/core';
import { getChangeSet, getUserWithBindings, type Db, type UserWithBindings } from '@arlo/db';
import { defineJob, Jobs } from '@arlo/queue';
import type { Logger } from '@arlo/config/logger';
import type { Executor, UndoResult } from './executor';

export const UNBOUND = '你的 Slack 帳號尚未對應到 Arlo 使用者，請先登入 Web console 或請 admin 協助綁定。';
export const DISABLED = '你的 Arlo 帳號已停用。';

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


export interface DecideDeps {
  db: Db;
  executor: Executor;
}

/**
 * approve / reject / undo / confirm on a ChangeSet. A plain `approve` of a pending Tier 3
 * ChangeSet only checks permission: approval happens on `confirm` (Requirement 4.4).
 */
export async function decide(
  deps: DecideDeps,
  user: UserWithBindings,
  verb: ChangeSetVerb,
  changesetId: string,
  opts: { reason?: string | null } = {},
): Promise<{ message: string | null; outcome?: string }> {
  const cs = await getChangeSet(deps.db, changesetId);
  if (!cs) return { message: DENY_TEXT.missing_target(null) };

  if (verb === 'approve' || verb === 'reject' || verb === 'confirm') {
    const action = verb === 'reject' ? 'reject' : 'approve';
    const decision = authorize(user, action, { accountId: cs.accountId, tier: cs.tier, requestedByUserId: cs.requestedBy.userId });
    if (!decision.allowed) return { message: DENY_TEXT[decision.reason](cs.tier), outcome: 'denied' };
    if (verb === 'approve' && cs.tier === 3 && cs.status === 'PENDING_APPROVAL') return { message: null, outcome: 'needs_confirm' };
    if (action === 'approve') {
      const result = await deps.executor.approve(cs.id, user.id);
      if (result.outcome === 'not_pending' || result.outcome === 'not_found') return { message: alreadyHandled(result.status, result.handledBy), outcome: result.outcome };
      if (result.outcome === 'expired') return { message: '這個變更已超過審核期限，未執行。', outcome: 'expired' };
      return { message: null, outcome: result.outcome };
    }
    const result = await deps.executor.reject(cs.id, user.id, opts.reason);
    return result.ok ? { message: null, outcome: 'rejected' } : { message: alreadyHandled(result.status, result.handledBy), outcome: 'not_pending' };
  }
  if (verb === 'undo') {
    const result = await deps.executor.undo(cs.id, user.id);
    return result.ok ? { message: null, outcome: 'reverted' } : { message: undoRefusal(result), outcome: result.reason };
  }
  return { message: null };
}

/** changeset.decide: decisions made in the Web console (Requirement 18.8). */
export function decisionJobs(deps: DecideDeps & { logger: Logger }) {
  return [
    defineJob(Jobs.changesetDecide, async (data) => {
      const user = await getUserWithBindings(deps.db, data.userId);
      if (!user) return { outcome: 'unknown_user' };
      const { message, outcome } = await decide(deps, user, data.verb, data.changesetId, { reason: data.reason });
      if (message) deps.logger.info({ changeset_id: data.changesetId, outcome }, message);
      return { outcome: outcome ?? null };
    }),
  ];
}
