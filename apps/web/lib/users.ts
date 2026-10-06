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

export const ROLE_LABEL: Record<Role, string> = { viewer: 'Viewer（檢視）', operator: 'Operator（提案 / Undo）', approver: 'Approver（審核）', admin: 'Admin（設定）' };

export const STATUS_BADGE = { active: ['ok', '啟用'], unbound: ['warn', 'Slack 未綁定'], disabled: ['bad', '停用'] } as const;

const UUID = /^[0-9a-f-]{36}$/i;
const SLACK_USER = /^[UW][A-Z0-9]{2,}$/;

export type BindingFormErrors = Partial<Record<'role' | 'accountIds' | 'maxTier', string>>;

/** Viewers and operators cannot approve, so their max tier is 0. */
export function parseBindingForm(form: FormData, knownAccounts: readonly string[]): { ok: true; value: BindingInput } | { ok: false; errors: BindingFormErrors } {
  const errors: BindingFormErrors = {};
  const role = String(form.get('role') ?? '') as Role;
  if (!(ROLES as readonly string[]).includes(role)) errors.role = '請選擇角色';
  const all = form.get('allAccounts') === 'on';
  const accountIds = all ? null : [...new Set(form.getAll('accountIds').map(String).filter(Boolean))];
  if (accountIds && (accountIds.length === 0 || accountIds.some((id) => !UUID.test(id) || !knownAccounts.includes(id)))) errors.accountIds = '請選擇帳戶，或勾選全部帳戶';
  const canApprove = role === 'approver' || role === 'admin';
  const maxTier = canApprove ? Number(form.get('maxTier')) : 0;
  if (canApprove && ![1, 2, 3].includes(maxTier)) errors.maxTier = '請選擇可審核的最高 Tier';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { role, accountIds, maxTier } };
}

export type AdminResult = { ok: true } | { ok: false; error: string };

const audit = (db: Db, actorId: string, entityId: string, action: string, payload?: unknown) =>
  writeAudit(db, { actor: { kind: 'user', id: actorId }, entityKind: 'user', entityId, action, payload });

export async function grantBinding(db: Db, actorId: string, userId: string, input: BindingInput): Promise<AdminResult> {
  if (!(await getUserWithBindings(db, userId))) return { ok: false, error: '找不到使用者' };
  const row = await addRoleBinding(db, userId, input);
  await audit(db, actorId, userId, 'grant_role', { bindingId: row.id, ...input });
  return { ok: true };
}

/** Refuses to remove the last admin binding so the org cannot lock itself out. */
export async function revokeBinding(db: Db, actorId: string, bindingId: string): Promise<AdminResult> {
  const binding = await getRoleBinding(db, bindingId);
  if (!binding) return { ok: false, error: '找不到這個權限' };
  if (binding.role === 'admin' && (await countOtherAdminBindings(db, bindingId)) === 0) return { ok: false, error: '這是最後一個 admin 權限，不能移除。' };
  await deleteRoleBinding(db, bindingId);
  await audit(db, actorId, binding.userId, 'revoke_role', { bindingId, role: binding.role, accountIds: binding.accountIds, maxTier: binding.maxTier });
  return { ok: true };
}

export async function bindSlackManually(db: Db, actorId: string, userId: string, slackUserId: string | null): Promise<AdminResult> {
  const id = slackUserId?.trim().toUpperCase() || null;
  if (id && !SLACK_USER.test(id)) return { ok: false, error: 'Slack user ID 格式應為 U 開頭，例如 U0123ABCD' };
  const result = await setSlackBinding(db, userId, id);
  if (!result.ok) return { ok: false, error: { user_not_found: '找不到使用者', user_disabled: '使用者已停用', slack_user_taken: '這個 Slack 帳號已綁定其他使用者' }[result.reason] };
  await audit(db, actorId, userId, id ? 'bind_slack' : 'unbind_slack', { slackUserId: id });
  return { ok: true };
}

export async function bindSlackByEmail(db: Db, actorId: string, userId: string, lookup: (email: string) => Promise<{ slackUserId: string } | null>): Promise<AdminResult> {
  const user = await getUserWithBindings(db, userId);
  if (!user) return { ok: false, error: '找不到使用者' };
  const outcome = await bindSlackUserByEmail(db, user, lookup);
  if (outcome === 'bound') {
    await audit(db, actorId, userId, 'bind_slack', { by: 'email' });
    return { ok: true };
  }
  return outcome === 'already_bound' ? { ok: true } : { ok: false, error: { not_found: 'Slack 找不到這個 email', slack_user_taken: '這個 Slack 帳號已綁定其他使用者', skipped_disabled: '使用者已停用' }[outcome] };
}

export async function setDisabled(db: Db, actorId: string, userId: string, disabled: boolean): Promise<AdminResult> {
  if (disabled && actorId === userId) return { ok: false, error: '不能停用自己。' };
  if (!(await setUserDisabled(db, userId, disabled))) return { ok: false, error: '找不到使用者' };
  await audit(db, actorId, userId, disabled ? 'disable' : 'enable');
  return { ok: true };
}

/** Pre-provisions a Workspace user so bindings can be set before their first sign-in. */
export async function addUser(db: Db, actorId: string, email: string, allowedDomain: string): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(normalized) || !normalized.endsWith(`@${allowedDomain.trim().toLowerCase()}`)) return { ok: false, error: `請輸入 @${allowedDomain} 的 email` };
  const user = await upsertUserOnSignIn(db, { email: normalized });
  await audit(db, actorId, user.id, 'provision', { email: normalized });
  return { ok: true, userId: user.id };
}
