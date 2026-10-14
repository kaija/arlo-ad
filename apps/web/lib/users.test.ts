import { DEFAULT_ORG_ID, getUserWithBindings, listAudit, listUsersWithBindings, upsertAdAccounts, upsertUserOnSignIn } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { addUser, bindSlackByEmail, bindSlackManually, grantBinding, parseBindingForm, revokeBinding, setDisabled } from './users';

const ACC = '0199b0c2-8f1e-7a3b-9c4d-123456789abc';
const form = (entries: [string, string][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

describe('parseBindingForm', () => {
  it.each([
    [[['role', 'approver'], ['maxTier', '3'], ['allAccounts', 'on']], { role: 'approver', accountIds: null, maxTier: 3 }],
    [[['role', 'operator'], ['maxTier', '3'], ['accountIds', ACC], ['accountIds', ACC]], { role: 'operator', accountIds: [ACC], maxTier: 0 }],
  ] as [string, string][][][])('parses %#', (entries, value) => {
    expect(parseBindingForm(form(entries as unknown as [string, string][]), [ACC])).toEqual({ ok: true, value });
  });

  it('requires a role, a scope and a tier for approvers', () => {
    expect(parseBindingForm(form([['role', 'root']]), [ACC])).toMatchObject({ ok: false, errors: { role: expect.any(String), accountIds: expect.any(String) } });
    expect(parseBindingForm(form([['role', 'approver'], ['maxTier', '0'], ['accountIds', 'other']]), [ACC])).toMatchObject({ ok: false, errors: { accountIds: expect.any(String), maxTier: expect.any(String) } });
  });
});

describe('RBAC administration', () => {
  const t = useTestDatabase();
  let admin: string;
  let ann: string;

  beforeAll(async () => {
    await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    admin = (await upsertUserOnSignIn(t.db, { email: 'admin@example.com' })).id;
    ann = (await upsertUserOnSignIn(t.db, { email: 'ann@example.com' })).id;
  });

  it('grants and revokes bindings, keeping at least one admin', async () => {
    expect(await grantBinding(t.db, admin, admin, { role: 'admin', accountIds: null, maxTier: 3 })).toEqual({ ok: true });
    const [own] = (await getUserWithBindings(t.db, admin))!.bindings;
    expect(await revokeBinding(t.db, admin, own!.id)).toEqual({ ok: false, error: expect.stringContaining('最後一個 admin') });

    await grantBinding(t.db, admin, ann, { role: 'admin', accountIds: null, maxTier: 3 });
    expect(await revokeBinding(t.db, admin, own!.id)).toEqual({ ok: true });
    expect((await getUserWithBindings(t.db, admin))!.bindings).toEqual([]);
    expect((await listAudit(t.db, 'user', admin)).map((a) => a.action)).toEqual(['grant_role', 'revoke_role']);
  });

  it('binds Slack manually or by email and refuses taken ids', async () => {
    expect(await bindSlackManually(t.db, admin, ann, 'bad id')).toMatchObject({ ok: false });
    expect(await bindSlackManually(t.db, admin, ann, 'u0123abcd')).toEqual({ ok: true });
    expect((await getUserWithBindings(t.db, ann))).toMatchObject({ slackUserId: 'U0123ABCD', status: 'active' });
    expect(await bindSlackManually(t.db, admin, admin, 'U0123ABCD')).toEqual({ ok: false, error: expect.stringContaining('已綁定其他使用者') });
    expect(await bindSlackByEmail(t.db, admin, admin, async () => null)).toEqual({ ok: false, error: 'Slack 找不到這個 email' });
    expect(await bindSlackByEmail(t.db, admin, admin, async (email) => (email === 'admin@example.com' ? { slackUserId: 'UADMIN1' } : null))).toEqual({ ok: true });
    expect(await bindSlackManually(t.db, admin, ann, null)).toEqual({ ok: true });
    expect((await getUserWithBindings(t.db, ann))).toMatchObject({ slackUserId: null, status: 'unbound' });
  });

  it('disables and re-enables, but never yourself', async () => {
    expect(await setDisabled(t.db, admin, admin, true)).toMatchObject({ ok: false });
    expect(await setDisabled(t.db, admin, ann, true)).toEqual({ ok: true });
    expect((await getUserWithBindings(t.db, ann))?.status).toBe('disabled');
    expect(await bindSlackManually(t.db, admin, ann, 'U999')).toEqual({ ok: false, error: '使用者已停用' });
    expect(await setDisabled(t.db, admin, ann, false)).toEqual({ ok: true });
    expect((await getUserWithBindings(t.db, ann))?.status).toBe('unbound');
  });

  it('pre-provisions users of the Workspace domain only', async () => {
    expect(await addUser(t.db, admin, 'pat@gmail.com', 'example.com')).toMatchObject({ ok: false });
    const added = await addUser(t.db, admin, ' Pat@Example.com ', 'example.com');
    expect(added).toMatchObject({ ok: true });
    expect((await listUsersWithBindings(t.db)).map((u) => u.googleEmail)).toContain('pat@example.com');
  });

  it('pre-provisions any address when no domain is configured', async () => {
    expect(await addUser(t.db, admin, 'not-an-email', undefined)).toMatchObject({ ok: false });
    expect(await addUser(t.db, admin, ' Pat@Gmail.com ', undefined)).toMatchObject({ ok: true });
    expect((await listUsersWithBindings(t.db)).map((u) => u.googleEmail)).toContain('pat@gmail.com');
  });
});
