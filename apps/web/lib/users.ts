// RBAC administration (ADR-0010, Requirements 1.3, 1.4, 18.4): role bindings with account scope
// and a maximum approvable tier, manual Slack binding for users the email lookup missed.
import { ROLES, type Role } from '@arlo/core';
import {
  addRoleBinding,
  bindSlackUserByEmail,
  countOtherAdminBindings,
  deleteRoleBinding,
  getRoleBinding,
  getUserWithBindings,
  setSlackBinding,
  setUserDisabled,
  upsertUserOnSignIn,
  writeAudit,
  type BindingInput,
  type Db,
} from '@arlo/db';
import { msg, type ErrorKey, type Msg } from './msg';

/** Badge tone per user status; the label is `users.status.*`. */
export const STATUS_TONE = { active: 'ok', unbound: 'warn', disabled: 'bad' } as const;

const UUID = /^[0-9a-f-]{36}$/i;
const SLACK_USER = /^[UW][A-Z0-9]{2,}$/;

export type BindingFormErrors = Partial<Record<'role' | 'accountIds' | 'maxTier', Msg>>;

/** Viewers and operators cannot approve, so their max tier is 0. */
export function parseBindingForm(form: FormData, knownAccounts: readonly string[]): { ok: true; value: BindingInput } | { ok: false; errors: BindingFormErrors } {
  const errors: BindingFormErrors = {};
  const role = String(form.get('role') ?? '') as Role;
  if (!(ROLES as readonly string[]).includes(role)) errors.role = 'chooseRole';
  const all = form.get('allAccounts') === 'on';
  const accountIds = all ? null : [...new Set(form.getAll('accountIds').map(String).filter(Boolean))];
  if (accountIds && (accountIds.length === 0 || accountIds.some((id) => !UUID.test(id) || !knownAccounts.includes(id)))) errors.accountIds = 'chooseAccountsOrAll';
  const canApprove = role === 'approver' || role === 'admin';
  const maxTier = canApprove ? Number(form.get('maxTier')) : 0;
  if (canApprove && ![1, 2, 3].includes(maxTier)) errors.maxTier = 'chooseMaxTier';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { role, accountIds, maxTier } };
}

export type AdminResult = { ok: true } | { ok: false; error: Msg };

const audit = (db: Db, actorId: string, entityId: string, action: string, payload?: unknown) =>
  writeAudit(db, { actor: { kind: 'user', id: actorId }, entityKind: 'user', entityId, action, payload });

export async function grantBinding(db: Db, actorId: string, userId: string, input: BindingInput): Promise<AdminResult> {
  if (!(await getUserWithBindings(db, userId))) return { ok: false, error: 'userNotFound' };
  const row = await addRoleBinding(db, userId, input);
  await audit(db, actorId, userId, 'grant_role', { bindingId: row.id, ...input });
  return { ok: true };
}

/** Refuses to remove the last admin binding so the org cannot lock itself out. */
export async function revokeBinding(db: Db, actorId: string, bindingId: string): Promise<AdminResult> {
  const binding = await getRoleBinding(db, bindingId);
  if (!binding) return { ok: false, error: 'bindingNotFound' };
  if (binding.role === 'admin' && (await countOtherAdminBindings(db, bindingId)) === 0) return { ok: false, error: 'lastAdmin' };
  await deleteRoleBinding(db, bindingId);
  await audit(db, actorId, binding.userId, 'revoke_role', { bindingId, role: binding.role, accountIds: binding.accountIds, maxTier: binding.maxTier });
  return { ok: true };
}

export async function bindSlackManually(db: Db, actorId: string, userId: string, slackUserId: string | null): Promise<AdminResult> {
  const id = slackUserId?.trim().toUpperCase() || null;
  if (id && !SLACK_USER.test(id)) return { ok: false, error: 'slackIdFormat' };
  const result = await setSlackBinding(db, userId, id);
  if (!result.ok) return { ok: false, error: ({ user_not_found: 'userNotFound', user_disabled: 'userDisabled', slack_user_taken: 'slackUserTaken' } as const)[result.reason] };
  await audit(db, actorId, userId, id ? 'bind_slack' : 'unbind_slack', { slackUserId: id });
  return { ok: true };
}

export async function bindSlackByEmail(db: Db, actorId: string, userId: string, lookup: (email: string) => Promise<{ slackUserId: string } | null>): Promise<AdminResult> {
  const user = await getUserWithBindings(db, userId);
  if (!user) return { ok: false, error: 'userNotFound' };
  const outcome = await bindSlackUserByEmail(db, user, lookup);
  if (outcome === 'bound') {
    await audit(db, actorId, userId, 'bind_slack', { by: 'email' });
    return { ok: true };
  }
  return outcome === 'already_bound' ? { ok: true } : { ok: false, error: ({ not_found: 'slackEmailNotFound', slack_user_taken: 'slackUserTaken', skipped_disabled: 'userDisabled' } as const)[outcome] };
}

/** Maps a failed Slack directory call to a message; token and scope problems are configuration, not outages. */
export function slackLookupError(err: unknown): ErrorKey {
  const code = (err as { data?: { error?: string } } | null)?.data?.error;
  if (code === 'missing_scope') return 'slackMissingScope';
  if (code === 'invalid_auth' || code === 'not_authed' || code === 'account_inactive' || code === 'token_revoked' || code === 'token_expired') return 'slackInvalidToken';
  return 'slackUnreachable';
}

export async function setDisabled(db: Db, actorId: string, userId: string, disabled: boolean): Promise<AdminResult> {
  if (disabled && actorId === userId) return { ok: false, error: 'cannotDisableSelf' };
  if (!(await setUserDisabled(db, userId, disabled))) return { ok: false, error: 'userNotFound' };
  await audit(db, actorId, userId, disabled ? 'disable' : 'enable');
  return { ok: true };
}

/** Pre-provisions a user so bindings can be set before their first sign-in. Without a domain any address is accepted. */
export async function addUser(db: Db, actorId: string, email: string, allowedDomain: string | undefined): Promise<{ ok: true; userId: string } | { ok: false; error: Msg }> {
  const normalized = email.trim().toLowerCase();
  const domain = allowedDomain?.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(normalized)) return { ok: false, error: 'validEmail' };
  if (domain && !normalized.endsWith(`@${domain}`)) return { ok: false, error: msg('emailDomain', { domain }) };
  const user = await upsertUserOnSignIn(db, { email: normalized });
  await audit(db, actorId, user.id, 'provision', { email: normalized });
  return { ok: true, userId: user.id };
}
