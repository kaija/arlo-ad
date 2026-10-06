import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_ID, roleBindings, users } from '../schema';
import { useTestDatabase } from '../testing';
import {
  bindSlackUserByEmail,
  getUserWithBindings,
  resolveSlackUser,
  setSlackBinding,
  upsertUserOnSignIn,
} from './identity';

describe('identity repository', () => {
  const t = useTestDatabase();
  let n = 0;
  const newUser = (email = `u${++n}@example.com`) => upsertUserOnSignIn(t.db, { email, displayName: null });

  it('upsertUserOnSignIn creates once, lowercases, and keeps the binding on later sign-ins', async () => {
    const first = await upsertUserOnSignIn(t.db, { email: 'Mixed@Example.com', displayName: 'Mixed' });
    await setSlackBinding(t.db, first.id, 'U-mixed');
    const again = await upsertUserOnSignIn(t.db, { email: 'mixed@example.com', displayName: null });
    expect(again).toMatchObject({ id: first.id, googleEmail: 'mixed@example.com', displayName: 'Mixed', slackUserId: 'U-mixed' });
  });

  describe('bindSlackUserByEmail', () => {
    const lookup = (map: Record<string, string>) => async (email: string) =>
      map[email] ? { slackUserId: map[email] } : null;

    it('binds a found Slack user', async () => {
      const user = await newUser('found@example.com');
      expect(await bindSlackUserByEmail(t.db, user, lookup({ 'found@example.com': 'U-found' }))).toBe('bound');
      expect(await getUserWithBindings(t.db, user.id)).toMatchObject({ slackUserId: 'U-found', status: 'active' });
    });

    it('reports not_found and leaves the user unbound', async () => {
      const user = await newUser();
      expect(await bindSlackUserByEmail(t.db, user, lookup({}))).toBe('not_found');
      expect(await getUserWithBindings(t.db, user.id)).toMatchObject({ slackUserId: null, status: 'unbound' });
    });

    it('refuses a Slack user that is already bound to another user', async () => {
      const a = await newUser('dup-a@example.com');
      const b = await newUser('dup-b@example.com');
      const same = lookup({ 'dup-a@example.com': 'U-dup', 'dup-b@example.com': 'U-dup' });
      expect(await bindSlackUserByEmail(t.db, a, same)).toBe('bound');
      expect(await bindSlackUserByEmail(t.db, b, same)).toBe('slack_user_taken');
      expect(await getUserWithBindings(t.db, b.id)).toMatchObject({ slackUserId: null, status: 'unbound' });
    });

    it('does not look up already bound or disabled users', async () => {
      const calls: string[] = [];
      const spy = async (email: string) => (calls.push(email), { slackUserId: 'U-x' });
      const bound = await newUser();
      await setSlackBinding(t.db, bound.id, 'U-already');
      expect(await bindSlackUserByEmail(t.db, (await getUserWithBindings(t.db, bound.id))!, spy)).toBe('already_bound');
      const [disabled] = await t.db
        .insert(users)
        .values({ orgId: DEFAULT_ORG_ID, googleEmail: 'off@example.com', status: 'disabled' })
        .returning();
      expect(await bindSlackUserByEmail(t.db, disabled!, spy)).toBe('skipped_disabled');
      expect(calls).toEqual([]);
    });
  });

  describe('setSlackBinding (admin)', () => {
    it('binds manually and unbinds with null', async () => {
      const user = await newUser();
      expect(await setSlackBinding(t.db, user.id, 'U-manual')).toMatchObject({ ok: true, user: { status: 'active' } });
      expect(await setSlackBinding(t.db, user.id, null)).toMatchObject({ ok: true, user: { status: 'unbound', slackUserId: null } });
    });

    it('rejects unknown and disabled users', async () => {
      expect(await setSlackBinding(t.db, '00000000-0000-7000-8000-000000000000', 'U-z')).toEqual({ ok: false, reason: 'user_not_found' });
      const [disabled] = await t.db
        .insert(users)
        .values({ orgId: DEFAULT_ORG_ID, googleEmail: 'off2@example.com', status: 'disabled' })
        .returning();
      expect(await setSlackBinding(t.db, disabled!.id, 'U-z')).toEqual({ ok: false, reason: 'user_disabled' });
    });
  });

  describe('resolveSlackUser', () => {
    it('returns the user with role bindings', async () => {
      const user = await newUser();
      await setSlackBinding(t.db, user.id, 'U-resolve');
      await t.db.insert(roleBindings).values({ orgId: DEFAULT_ORG_ID, userId: user.id, role: 'operator', accountIds: ['acc-1'] });
      const resolved = await resolveSlackUser(t.db, 'U-resolve');
      expect(resolved).toMatchObject({ ok: true, user: { id: user.id, bindings: [{ role: 'operator', accountIds: ['acc-1'] }] } });
    });

    it('treats unknown Slack users as unbound and refuses disabled users', async () => {
      expect(await resolveSlackUser(t.db, 'U-nobody')).toEqual({ ok: false, reason: 'unbound' });
      await t.db
        .insert(users)
        .values({ orgId: DEFAULT_ORG_ID, googleEmail: 'off3@example.com', status: 'disabled', slackUserId: 'U-off' });
      expect(await resolveSlackUser(t.db, 'U-off')).toEqual({ ok: false, reason: 'disabled' });
    });
  });
});
