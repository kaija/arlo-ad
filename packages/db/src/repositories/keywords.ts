// Business Profiles (ADR-0019). Saving inserts the next version; reads take the latest.
import { BusinessProfileSchema, withExample, type BusinessProfile, type ProfileExample } from '@arlo/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { businessProfiles, DEFAULT_ORG_ID } from '../schema';
import type { Db } from '../client';
import { writeAudit, type Actor } from './changesets';
import type { DbOrTx } from './upsert';

export interface StoredProfile {
  accountId: string;
  version: number;
  profile: BusinessProfile;
  createdAt: Date;
  createdBy: string | null;
}

const toStored = (r: typeof businessProfiles.$inferSelect): StoredProfile => ({
  accountId: r.accountId,
  version: r.version,
  profile: BusinessProfileSchema.parse(r.profile),
  createdAt: r.createdAt,
  createdBy: r.createdBy,
});

export async function getBusinessProfile(db: DbOrTx, accountId: string, version?: number): Promise<StoredProfile | undefined> {
  const [row] = await db
    .select()
    .from(businessProfiles)
    .where(and(eq(businessProfiles.accountId, accountId), version === undefined ? undefined : eq(businessProfiles.version, version)))
    .orderBy(desc(businessProfiles.version))
    .limit(1);
  return row ? toStored(row) : undefined;
}

export async function listProfileVersions(db: DbOrTx, accountId: string, limit = 20) {
  return db
    .select({ version: businessProfiles.version, createdAt: businessProfiles.createdAt, createdBy: businessProfiles.createdBy })
    .from(businessProfiles)
    .where(eq(businessProfiles.accountId, accountId))
    .orderBy(desc(businessProfiles.version))
    .limit(limit);
}

/** Stores `profile` as the account's next version (validated); returns it. Audited. */
export async function saveBusinessProfile(db: Db, accountId: string, profile: BusinessProfile, actor: Actor): Promise<StoredProfile> {
  const parsed = BusinessProfileSchema.parse(profile);
  return db.transaction(async (tx) => {
    // Serialize writers per account so two saves cannot take the same version.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`business_profile:${accountId}`}, 0))`);
    const [last] = await tx
      .select({ version: businessProfiles.version })
      .from(businessProfiles)
      .where(eq(businessProfiles.accountId, accountId))
      .orderBy(desc(businessProfiles.version))
      .limit(1);
    const version = (last?.version ?? 0) + 1;
    const [row] = await tx.insert(businessProfiles).values({ orgId: DEFAULT_ORG_ID, accountId, version, profile: parsed, createdBy: actor.id ?? null }).returning();
    await writeAudit(tx, { actor, entityKind: 'business_profile', entityId: row!.id, action: 'save', payload: { accountId, version } });
    return toStored(row!);
  });
}

/** Records a labelled term (e.g. an approver's correction, Requirement 14.6) as a new version. */
export async function addProfileExample(db: Db, accountId: string, example: ProfileExample, actor: Actor): Promise<StoredProfile> {
  const current = await getBusinessProfile(db, accountId);
  const base: BusinessProfile = current?.profile ?? { offerings: [], targetIntents: [], excludedIntents: [], brandTerms: [], competitorPolicy: 'review', examples: [] };
  return saveBusinessProfile(db, accountId, withExample(base, example), actor);
}
