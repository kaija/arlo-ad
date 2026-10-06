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
