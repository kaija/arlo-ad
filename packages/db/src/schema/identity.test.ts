import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../testing';
import { DEFAULT_ORG_ID, orgs, roleBindings, settings, users } from './identity';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

// Drizzle wraps driver errors; the SQLSTATE lives on the pg error in `cause`.
async function sqlState(query: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await query;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

describe('identity schema', () => {
  const t = useTestDatabase();
  let n = 0;
  const email = () => `user${++n}@example.com`;

  const insertUser = (values: Partial<typeof users.$inferInsert> = {}) =>
    t.db
      .insert(users)
      .values({ orgId: DEFAULT_ORG_ID, googleEmail: email(), ...values })
      .returning()
      .then(([row]) => row!);

  it('seeds exactly one org', async () => {
    expect(await t.db.select({ id: orgs.id, name: orgs.name }).from(orgs)).toEqual([{ id: DEFAULT_ORG_ID, name: 'Arlo' }]);
  });

  describe('users', () => {
    it('defaults to unbound with uuidv7 id and timestamps', async () => {
      const user = await insertUser();
      expect(user).toMatchObject({ status: 'unbound', slackUserId: null, orgId: DEFAULT_ORG_ID });
      expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
      expect(user.createdAt).toBeInstanceOf(Date);
    });

    it('rejects duplicate email and Slack user within an org', async () => {
      const user = await insertUser({ slackUserId: 'U1', status: 'active' });
      expect(await sqlState(insertUser({ googleEmail: user.googleEmail }))).toBe(UNIQUE_VIOLATION);
      expect(await sqlState(insertUser({ slackUserId: 'U1', status: 'active' }))).toBe(UNIQUE_VIOLATION);
    });

    it('allows many unbound users without a Slack user', async () => {
      await insertUser();
      await insertUser();
      const unbound = await t.db.select().from(users).where(eq(users.status, 'unbound'));
      expect(unbound.length).toBeGreaterThanOrEqual(2);
    });

    it('requires lowercase emails', async () => {
      expect(await sqlState(insertUser({ googleEmail: 'Pat@Example.com' }))).toBe(CHECK_VIOLATION);
    });

    it.each([
      ['active without Slack user', { status: 'active' as const }, CHECK_VIOLATION],
      ['unbound with Slack user', { status: 'unbound' as const, slackUserId: 'U-unbound' }, CHECK_VIOLATION],
      ['disabled without Slack user', { status: 'disabled' as const }, undefined],
      ['disabled with Slack user', { status: 'disabled' as const, slackUserId: 'U-disabled' }, undefined],
    ])('status must match the Slack binding: %s', async (_, values, expected) => {
      expect(await sqlState(insertUser(values))).toBe(expected);
    });

    it('requires an existing org', async () => {
      expect(await sqlState(insertUser({ orgId: '00000000-0000-0000-0000-00000000ffff' }))).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('refreshes updated_at on update', async () => {
      const user = await insertUser();
      const [updated] = await t.db
        .update(users)
        .set({ slackUserId: 'U-bind', status: 'active' })
        .where(eq(users.id, user.id))
        .returning();
      expect(updated!.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime());
    });
  });

  describe('role_bindings', () => {
    const bind = async (values: Partial<typeof roleBindings.$inferInsert> = {}) => {
      const user = await insertUser();
      return t.db.insert(roleBindings).values({ orgId: DEFAULT_ORG_ID, userId: user.id, role: 'approver', ...values });
    };

    it('accepts account scope and max tier', async () => {
      expect(await sqlState(bind({ accountIds: ['1234567890'], maxTier: 3 }))).toBeUndefined();
      expect(await sqlState(bind({ role: 'viewer' }))).toBeUndefined();
    });

    it.each([-1, 4])('rejects max_tier %i', async (maxTier) => {
      expect(await sqlState(bind({ maxTier }))).toBe(CHECK_VIOLATION);
    });

    it('rejects an empty account list (use null for all accounts)', async () => {
      expect(await sqlState(bind({ accountIds: [] }))).toBe(CHECK_VIOLATION);
    });

    it('is deleted with its user', async () => {
      const user = await insertUser();
      await t.db.insert(roleBindings).values({ orgId: DEFAULT_ORG_ID, userId: user.id, role: 'admin', maxTier: 3 });
      await t.db.delete(users).where(eq(users.id, user.id));
      expect(await t.db.select().from(roleBindings).where(eq(roleBindings.userId, user.id))).toEqual([]);
    });
  });

  describe('settings', () => {
    it('stores JSON values keyed per org', async () => {
      await t.db.insert(settings).values({ orgId: DEFAULT_ORG_ID, key: 'sla_minutes', value: 60 });
      expect(await sqlState(t.db.insert(settings).values({ orgId: DEFAULT_ORG_ID, key: 'sla_minutes', value: 30 }))).toBe(
        UNIQUE_VIOLATION,
      );
      const [row] = await t.db.select().from(settings).where(eq(settings.key, 'sla_minutes'));
      expect(row!.value).toBe(60);
    });
  });
});
