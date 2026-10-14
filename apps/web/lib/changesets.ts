// Review queue and audit view (Requirement 18.3). Decisions go through changeset.decide so the
// worker applies the same authorize + Executor path as Slack (Requirement 18.8).
import { authorize, CHANGESET_STATUSES, type ChangeSetStatus, type ChangeSetView, type Tier } from '@arlo/core';
import {
  getAdAccount,
  getChangeSet,
  getUserWithBindings,
  listAudit,
  listChangeSets,
  listOpResults,
  loadChangeSetView,
  resolveAccounts,
  type AdAccount,
  type DbOrTx,
  type StoredChangeSet,
} from '@arlo/db';
import type { ArloSessionUser } from './auth-config';

export const UNDO_WINDOW_MS = 24 * 3_600_000;

export const STATUS_TONE: Record<ChangeSetStatus, 'neutral' | 'ok' | 'warn' | 'bad' | 'info'> = {
  PENDING_VALIDATION: 'info',
  BLOCKED: 'bad',
  PENDING_APPROVAL: 'warn',
  APPROVED: 'info',
  EXECUTING: 'info',
  EXECUTED: 'ok',
  FAILED: 'bad',
  REJECTED: 'neutral',
  STALE: 'neutral',
  EXPIRED: 'neutral',
  SIMULATED: 'info',
  REVERTED: 'neutral',
};

/** Badge tone per tier: Tier 3 stands out, Tier 1 (auto-executed) recedes. */
export const tierTone = (tier: number | null): 'neutral' | 'warn' | 'info' => (tier === 3 ? 'warn' : tier === 2 ? 'info' : 'neutral');

/** Change set sources with a translated label (`changeset.source.*`); others show their raw kind. */
export const SOURCE_KINDS = ['chat', 'schedule', 'monitor', 'web', 'undo'] as const;
export const isSourceKind = (kind: string): kind is (typeof SOURCE_KINDS)[number] => (SOURCE_KINDS as readonly string[]).includes(kind);

export function traceUrl(traceId: string | null | undefined): string | null {
  return traceId ? `https://platform.openai.com/traces/trace?trace_id=${encodeURIComponent(traceId)}` : null;
}

export interface QueueFilter {
  status?: ChangeSetStatus;
  tier?: Tier;
  account?: string;
}

/** Query string → filter; unknown values are dropped. */
export function parseQueueFilter(params: Record<string, string | string[] | undefined>): QueueFilter {
  const one = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : undefined);
  const status = one('status');
  const tier = Number(one('tier'));
  return {
    ...(status && (CHANGESET_STATUSES as readonly string[]).includes(status) ? { status: status as ChangeSetStatus } : {}),
    ...(one('tier') && [0, 1, 2, 3].includes(tier) ? { tier: tier as Tier } : {}),
    ...(one('account') ? { account: one('account') } : {}),
  };
}

export interface QueueRow {
  cs: StoredChangeSet;
  accountName: string;
}

export async function loadQueue(db: DbOrTx, allowed: readonly string[] | null, filter: QueueFilter, limit = 100): Promise<{ rows: QueueRow[]; accounts: AdAccount[] }> {
  const accounts = await resolveAccounts(db, { allowed });
  const scoped = filter.account ? accounts.filter((a) => a.id === filter.account).map((a) => a.id) : allowed === null ? null : accounts.map((a) => a.id);
  const rows = await listChangeSets(db, {
    statuses: filter.status ? [filter.status] : undefined,
    tiers: filter.tier !== undefined ? [filter.tier] : undefined,
    accountIds: scoped,
    limit,
  });
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  return { rows: rows.map((cs) => ({ cs, accountName: names.get(cs.accountId) ?? cs.accountId })), accounts };
}

export interface AvailableActions {
  approve: boolean;
  /** Tier 3 asks for an explicit confirmation (Requirement 4.4). */
  confirm: boolean;
  reject: boolean;
  undo: boolean;
}

export function availableActions(user: ArloSessionUser, cs: StoredChangeSet, now: Date): AvailableActions {
  const target = { accountId: cs.accountId, tier: cs.tier, requestedByUserId: cs.requestedBy.userId };
  const pending = cs.status === 'PENDING_APPROVAL';
  const approve = pending && authorize(user, 'approve', target).allowed;
  return {
    approve,
    confirm: approve && cs.tier === 3,
    reject: pending && authorize(user, 'reject', target).allowed,
    undo:
      cs.status === 'EXECUTED' &&
      !!cs.executedAt &&
      now.getTime() - cs.executedAt.getTime() <= UNDO_WINDOW_MS &&
      cs.ops.every((op) => op.field) &&
      authorize(user, 'undo', { accountId: cs.accountId }).allowed,
  };
}

export interface AuditRow {
  at: Date;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorKind: string;
  /** Display name; null for the system or a user who no longer exists (the page labels those). */
  actor: string | null;
  reason: string | null;
}

export interface ChangeSetDetail {
  cs: StoredChangeSet;
  account: AdAccount;
  view: ChangeSetView;
  approver: string | null;
  traceUrl: string | null;
  opResults: { opIndex: number; ok: boolean; error: string | null; resourceName: string | null }[];
  audit: AuditRow[];
  revertOf: StoredChangeSet | null;
}

/** One ChangeSet the user may read, with its card view, op results and audit trail. */
export async function loadDetail(db: DbOrTx, id: string, allowed: readonly string[] | null): Promise<ChangeSetDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const cs = await getChangeSet(db, id);
  if (!cs || (allowed !== null && !allowed.includes(cs.accountId))) return null;
  const account = await getAdAccount(db, cs.accountId);
  if (!account) return null;
  const [view, results, audit, revertOf] = await Promise.all([
    loadChangeSetView(db, cs, account),
    listOpResults(db, cs.id),
    listAudit(db, 'changeset', cs.id),
    cs.revertOf ? getChangeSet(db, cs.revertOf) : undefined,
  ]);
  const names = new Map<string, string>();
  for (const id of new Set([...audit.map((a) => a.actorId), cs.approvedBy].filter((x): x is string => !!x))) {
    const u = await getUserWithBindings(db, id);
    if (u) names.set(id, u.displayName ?? u.googleEmail);
  }
  return {
    cs,
    account,
    view,
    approver: cs.approvedBy ? (names.get(cs.approvedBy) ?? null) : null,
    traceUrl: traceUrl(cs.traceId),
    opResults: results.map((r) => ({ opIndex: r.opIndex, ok: r.ok, error: r.error, resourceName: r.resourceName })),
    audit: audit.map((a) => ({
      at: a.at,
      action: a.action,
      fromStatus: a.fromStatus,
      toStatus: a.toStatus,
      // Display name for users, 'Arlo' for the agent, null for the system (the page labels it).
      actorKind: a.actorKind,
      actor: a.actorKind === 'user' ? (names.get(a.actorId ?? '') ?? null) : a.actorKind === 'agent' ? 'Arlo' : null,
      reason: ((a.payload as { reason?: string } | null)?.reason ?? null) || null,
    })),
    revertOf: revertOf ?? null,
  };
}

export type DecisionVerb = 'approve' | 'confirm' | 'reject' | 'undo';

/** Whether the user may submit `verb` now; the worker checks again before acting. */
export function mayDecide(user: ArloSessionUser, cs: StoredChangeSet, verb: DecisionVerb, now: Date): boolean {
  const a = availableActions(user, cs, now);
  if (verb === 'approve') return a.approve && !a.confirm;
  if (verb === 'confirm') return a.confirm;
  return a[verb];
}
