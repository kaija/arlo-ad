'use server';

import { createSlackDirectory } from '@arlo/adapters/chat';
import { EnvSchema, parseEnv } from '@arlo/config';
import { resolveAccounts } from '@arlo/db';
import { WebClient } from '@slack/web-api';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { translateMsg } from '../../../../lib/i18n-server';
import { getDb } from '../../../../lib/server';
import { requireAuthorized } from '../../../../lib/session';
import { addUser, bindSlackByEmail, bindSlackManually, grantBinding, parseBindingForm, revokeBinding, setDisabled, type AdminResult } from '../../../../lib/users';

type OkKey = 'granted' | 'revoked' | 'slackBound' | 'slackUnbound' | 'slackMatched' | 'disabled' | 'enabled' | 'added';

// RBAC is a setting (Requirement 18.4): admins only. Results come back as translated query parameters.
async function done(userId: string, result: AdminResult, ok: OkKey): Promise<never> {
  revalidatePath('/settings/users');
  revalidatePath(`/settings/users/${userId}`);
  const text = result.ok ? (await getTranslations('users'))(`ok.${ok}`) : await translateMsg(result.error);
  redirect(`/settings/users/${userId}?${result.ok ? 'ok' : 'error'}=${encodeURIComponent(text)}`);
}

export async function grantAction(userId: string, form: FormData): Promise<void> {
  const admin = await requireAuthorized('admin');
  const db = getDb();
  const accounts = (await resolveAccounts(db, { allowed: null })).map((a) => a.id);
  const parsed = parseBindingForm(form, accounts);
  if (!parsed.ok) {
    // One message per invalid field, joined into a single banner.
    const messages = await Promise.all(Object.values(parsed.errors).flatMap((m) => (m ? [translateMsg(m)] : [])));
    revalidatePath(`/settings/users/${userId}`);
    redirect(`/settings/users/${userId}?error=${encodeURIComponent(messages.join(' / '))}`);
  }
  await done(userId, await grantBinding(db, admin.id, userId, parsed.value), 'granted');
}

export async function revokeAction(userId: string, bindingId: string): Promise<void> {
  const admin = await requireAuthorized('admin');
  await done(userId, await revokeBinding(getDb(), admin.id, bindingId), 'revoked');
}

export async function bindSlackAction(userId: string, form: FormData): Promise<void> {
  const admin = await requireAuthorized('admin');
  await done(userId, await bindSlackManually(getDb(), admin.id, userId, String(form.get('slackUserId') ?? '')), 'slackBound');
}

export async function unbindSlackAction(userId: string): Promise<void> {
  const admin = await requireAuthorized('admin');
  await done(userId, await bindSlackManually(getDb(), admin.id, userId, null), 'slackUnbound');
}

export async function lookupSlackAction(userId: string): Promise<void> {
  const admin = await requireAuthorized('admin');
  const directory = createSlackDirectory(new WebClient(parseEnv(EnvSchema.pick({ SLACK_BOT_TOKEN: true })).SLACK_BOT_TOKEN));
  let result: AdminResult;
  try {
    result = await bindSlackByEmail(getDb(), admin.id, userId, (email) => directory.lookupByEmail(email));
  } catch {
    result = { ok: false, error: 'slackUnreachable' };
  }
  await done(userId, result, 'slackMatched');
}

export async function setDisabledAction(userId: string, disabled: boolean): Promise<void> {
  const admin = await requireAuthorized('admin');
  await done(userId, await setDisabled(getDb(), admin.id, userId, disabled), disabled ? 'disabled' : 'enabled');
}

export async function addUserAction(form: FormData): Promise<void> {
  const admin = await requireAuthorized('admin');
  const result = await addUser(getDb(), admin.id, String(form.get('email') ?? ''), parseEnv(EnvSchema.pick({ ALLOWED_WORKSPACE_DOMAIN: true })).ALLOWED_WORKSPACE_DOMAIN);
  revalidatePath('/settings/users');
  if (!result.ok) redirect(`/settings/users?error=${encodeURIComponent(await translateMsg(result.error))}`);
  redirect(`/settings/users/${result.userId}?ok=${encodeURIComponent((await getTranslations('users'))('ok.added'))}`);
}
