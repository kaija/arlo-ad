// Tier 3 confirm modal (Requirement 4.4, ADR-0007). Slack's trigger_id expires about 3 seconds
// after the click, so the modal opens here in the interactivity request instead of the worker.
// Approval itself still happens in the worker when the modal is submitted (cs:confirm).
import type { ChatAdapter } from '@arlo/adapters/chat';
import { authorize, decodeAction, type ConversationRef } from '@arlo/core';
import { getAdAccount, getChangeSet, loadChangeSetView, resolveSlackUser, type DbOrTx } from '@arlo/db';

export interface ConfirmClick {
  triggerId: string;
  userId: string;
  changesetId: string;
  where?: ConversationRef;
}

interface ClickPayload {
  type?: string;
  trigger_id?: string;
  user?: { id?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; thread_ts?: string };
  message?: { thread_ts?: string };
  actions?: { action_id?: string }[];
}

/** An Approve click (block_actions) with its trigger_id; anything else → null. */
export function confirmClick(raw: string): ConfirmClick | null {
  let p: ClickPayload;
  try {
    p = JSON.parse(new URLSearchParams(raw).get('payload') ?? '') as ClickPayload;
  } catch {
    return null;
  }
  if (p.type !== 'block_actions' || !p.trigger_id || !p.user?.id) return null;
  const approve = (p.actions ?? []).map((a) => (a.action_id ? decodeAction(a.action_id) : null)).find((a) => a?.kind === 'changeset' && a.verb === 'approve');
  if (!approve) return null;
  const channelId = p.channel?.id ?? p.container?.channel_id;
  const threadId = p.message?.thread_ts ?? p.container?.thread_ts;
  return {
    triggerId: p.trigger_id,
    userId: p.user.id,
    changesetId: approve.changesetId,
    ...(channelId ? { where: { platform: 'slack' as const, channelId, ...(threadId ? { threadId } : {}) } } : {}),
  };
}

export type ConfirmOutcome = 'opened' | 'not_tier3' | 'denied';

/**
 * Opens the confirm modal when the click approves a pending Tier 3 ChangeSet and the user may
 * approve it. Denials are left to the worker, which answers with an ephemeral message.
 */
export async function openTier3Confirm(db: DbOrTx, chat: ChatAdapter, click: ConfirmClick): Promise<ConfirmOutcome> {
  const cs = await getChangeSet(db, click.changesetId);
  if (!cs || cs.status !== 'PENDING_APPROVAL' || cs.tier !== 3) return 'not_tier3';
  const resolved = await resolveSlackUser(db, click.userId);
  if (!resolved.ok) return 'denied';
  if (!authorize(resolved.user, 'approve', { accountId: cs.accountId, tier: cs.tier, requestedByUserId: cs.requestedBy.userId }).allowed) return 'denied';
  const account = await getAdAccount(db, cs.accountId);
  if (!account) return 'not_tier3';
  await chat.openConfirm(click.triggerId, await loadChangeSetView(db, cs, account), click.where);
  return 'opened';
}
