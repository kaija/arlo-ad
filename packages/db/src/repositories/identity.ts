// Internal users are the identity root (ADR-0010): Google email from SSO, Slack user bound
// on first sign-in or by an admin, role bindings for authorization.
import { and, asc, eq, sql } from 'drizzle-orm';
import { DEFAULT_ORG_ID, roleBindings, users } from '../schema';
import type { DbOrTx } from './upsert';

export type User = typeof users.$inferSelect;
export type RoleBinding = typeof roleBindings.$inferSelect;
export interface UserWithBindings extends User {
  bindings: RoleBinding[];
}

/** Creates the user on first sign-in; later sign-ins refresh the display name only. */
export async function upsertUserOnSignIn(db: DbOrTx, input: { email: string; displayName?: string | null }): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({ orgId: DEFAULT_ORG_ID, googleEmail: input.email.toLowerCase(), displayName: input.displayName ?? null })
    .onConflictDoUpdate({
      target: [users.orgId, users.googleEmail],
      set: { displayName: sql`coalesce(excluded.display_name, ${users.displayName})`, updatedAt: sql`now()` },
    })
    .returning();
  return row!;
}

export async function findUserByEmail(db: DbOrTx, email: string): Promise<User | undefined> {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.orgId, DEFAULT_ORG_ID), eq(users.googleEmail, email.toLowerCase())));
  return row;
}

async function withBindings(db: DbOrTx, user: User | undefined): Promise<UserWithBindings | undefined> {
  if (!user) return undefined;
  const bindings = await db
    .select()
    .from(roleBindings)
    .where(eq(roleBindings.userId, user.id))
    .orderBy(asc(roleBindings.createdAt));
  return { ...user, bindings };
}

export async function getUserWithBindings(db: DbOrTx, userId: string): Promise<UserWithBindings | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return withBindings(db, user);
}

export async function findUserBySlackId(db: DbOrTx, slackUserId: string): Promise<UserWithBindings | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.orgId, DEFAULT_ORG_ID), eq(users.slackUserId, slackUserId)));
  return withBindings(db, user);
}

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return (e.cause?.code ?? e.code) === UNIQUE_VIOLATION;
}

export type SlackBindingResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'user_not_found' | 'user_disabled' | 'slack_user_taken' };

/**
 * Binds (or with null, unbinds) a Slack user; status follows the binding (active ⇔ bound).
 * Used by first sign-in and by admins for manual binding (Requirement 1.3).
 */
export async function setSlackBinding(db: DbOrTx, userId: string, slackUserId: string | null): Promise<SlackBindingResult> {
  const [current] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId));
  if (!current) return { ok: false, reason: 'user_not_found' };
  if (current.status === 'disabled') return { ok: false, reason: 'user_disabled' };
  try {
    const [user] = await db
      .update(users)
      .set({ slackUserId, status: slackUserId ? 'active' : 'unbound' })
      .where(and(eq(users.id, userId), sql`${users.status} <> 'disabled'`))
      .returning();
    return user ? { ok: true, user } : { ok: false, reason: 'user_disabled' };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'slack_user_taken' };
    throw err;
  }
}

export type AutoBindOutcome = 'already_bound' | 'bound' | 'not_found' | 'slack_user_taken' | 'skipped_disabled';

/**
 * First-sign-in binding (Requirement 1.2): looks the user's email up in Slack. Users that
 * stay unbound are handled by an admin (Requirement 1.3).
 */
export async function bindSlackUserByEmail(
  db: DbOrTx,
  user: User,
  lookupByEmail: (email: string) => Promise<{ slackUserId: string } | null>,
): Promise<AutoBindOutcome> {
  if (user.status === 'disabled') return 'skipped_disabled';
  if (user.slackUserId) return 'already_bound';
  const found = await lookupByEmail(user.googleEmail);
  if (!found) return 'not_found';
  const result = await setSlackBinding(db, user.id, found.slackUserId);
  if (result.ok) return 'bound';
  return result.reason === 'slack_user_taken' ? 'slack_user_taken' : 'skipped_disabled';
}

export type ResolvedSlackUser = { ok: true; user: UserWithBindings } | { ok: false; reason: 'unbound' | 'disabled' };

/** Maps a Slack interaction to the internal user (Requirement 1.5). Unknown Slack users are unbound. */
export async function resolveSlackUser(db: DbOrTx, slackUserId: string): Promise<ResolvedSlackUser> {
  const user = await findUserBySlackId(db, slackUserId);
  if (!user) return { ok: false, reason: 'unbound' };
  if (user.status === 'disabled') return { ok: false, reason: 'disabled' };
  return { ok: true, user };
}
