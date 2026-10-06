'use server';

import { createSlackDirectory } from '@arlo/adapters/chat';
import { EnvSchema, parseEnv } from '@arlo/config';
import { resolveAccounts } from '@arlo/db';
import { WebClient } from '@slack/web-api';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getDb } from '../../../../lib/server';
import { requireAuthorized } from '../../../../lib/session';
import { addUser, bindSlackByEmail, bindSlackManually, grantBinding, parseBindingForm, revokeBinding, setDisabled, type AdminResult } from '../../../../lib/users';

// RBAC is a setting (Requirement 18.4): admins only. Results come back as query parameters.
function done(userId: string, result: AdminResult, ok: string): never {
  revalidatePath('/settings/users');
  revalidatePath(`/settings/users/${userId}`);
  redirect(`/settings/users/${userId}?${result.ok ? `ok=${encodeURIComponent(ok)}` : `error=${encodeURIComponent(result.error)}`}`);
}

export async function grantAction(userId: string, form: FormData): Promise<void> {
  const admin = await requireAuthorized('admin');
  const db = getDb();
  const accounts = (await resolveAccounts(db, { allowed: null })).map((a) => a.id);
  const parsed = parseBindingForm(form, accounts);
  if (!parsed.ok) done(userId, { ok: false, error: Object.values(parsed.errors).join('；') }, '');
  done(userId, await grantBinding(db, admin.id, userId, parsed.value), '已新增權限');
}

export async function revokeAction(userId: string, bindingId: string): Promise<void> {
  const admin = await requireAuthorized('admin');
  done(userId, await revokeBinding(getDb(), admin.id, bindingId), '已移除權限');
}

export async function bindSlackAction(userId: string, form: FormData): Promise<void> {
  const admin = await requireAuthorized('admin');
  done(userId, await bindSlackManually(getDb(), admin.id, userId, String(form.get('slackUserId') ?? '')), '已綁定 Slack');
}

export async function unbindSlackAction(userId: string): Promise<void> {
  const admin = await requireAuthorized('admin');
  done(userId, await bindSlackManually(getDb(), admin.id, userId, null), '已解除 Slack 綁定');
}

export async function lookupSlackAction(userId: string): Promise<void> {
  const admin = await requireAuthorized('admin');
  const directory = createSlackDirectory(new WebClient(parseEnv(EnvSchema.pick({ SLACK_BOT_TOKEN: true })).SLACK_BOT_TOKEN));
  let result: AdminResult;
  try {
    result = await bindSlackByEmail(getDb(), admin.id, userId, (email) => directory.lookupByEmail(email));
  } catch {
    result = { ok: false, error: '無法連線 Slack，請稍後再試或手動輸入 Slack user ID' };
  }
  done(userId, result, '已從 Slack 對應');
}

export async function setDisabledAction(userId: string, disabled: boolean): Promise<void> {
  const admin = await requireAuthorized('admin');
  done(userId, await setDisabled(getDb(), admin.id, userId, disabled), disabled ? '已停用' : '已啟用');
}

export async function addUserAction(form: FormData): Promise<void> {
  const admin = await requireAuthorized('admin');
  const result = await addUser(getDb(), admin.id, String(form.get('email') ?? ''), parseEnv(EnvSchema.pick({ ALLOWED_WORKSPACE_DOMAIN: true })).ALLOWED_WORKSPACE_DOMAIN);
  revalidatePath('/settings/users');
  if (!result.ok) redirect(`/settings/users?error=${encodeURIComponent(result.error)}`);
  redirect(`/settings/users/${result.userId}?ok=${encodeURIComponent('已新增使用者')}`);
}
