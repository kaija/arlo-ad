// Business Profiles (ADR-0019). Saving inserts the next version; reads take the latest.
import { createHash } from 'node:crypto';
import { BusinessProfileSchema, normalizeSearchTerm, withExample, type BusinessProfile, type ProfileExample, type SearchTermLabel } from '@arlo/core';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { businessProfiles, DEFAULT_ORG_ID, gSearchTermLabels } from '../schema';
import type { Db } from '../client';
import { writeAudit, type Actor } from './changesets';
import { inBatches, type DbOrTx } from './upsert';

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

// --- classifier cache (Requirement 14.3) ----------------------------------------------------

export const searchTermHash = (term: string) => createHash('sha256').update(normalizeSearchTerm(term)).digest('hex');

/** Cached labels for `terms` under a profile version, keyed by normalized term. */
export async function getSearchTermLabels(db: DbOrTx, accountId: string, profileVersion: number, terms: readonly string[]): Promise<Map<string, SearchTermLabel>> {
  const out = new Map<string, SearchTermLabel>();
  const hashes = [...new Set(terms.map(searchTermHash))];
  for (let i = 0; i < hashes.length; i += 5000) {
    const rows = await db
      .select()
      .from(gSearchTermLabels)
      .where(and(eq(gSearchTermLabels.accountId, accountId), eq(gSearchTermLabels.profileVersion, profileVersion), inArray(gSearchTermLabels.termHash, hashes.slice(i, i + 5000))));
    for (const r of rows) out.set(normalizeSearchTerm(r.term), { intent: r.intent, relevant: r.relevant, confidence: r.confidence, reason: r.reason });
  }
  return out;
}

export async function saveSearchTermLabels(
  db: DbOrTx,
  accountId: string,
  profileVersion: number,
  labels: readonly (SearchTermLabel & { term: string })[],
  model: string | null,
): Promise<void> {
  const byHash = new Map(labels.map((l) => [searchTermHash(l.term), l]));
  const rows = [...byHash].map(([termHash, l]) => ({
    orgId: DEFAULT_ORG_ID,
    accountId,
    termHash,
    term: normalizeSearchTerm(l.term),
    profileVersion,
    intent: l.intent,
    relevant: l.relevant,
    confidence: Math.min(1, Math.max(0, Math.round(l.confidence * 1000) / 1000)),
    reason: l.reason.slice(0, 500),
    model,
  }));
  await inBatches(gSearchTermLabels, rows, (batch) =>
    db
      .insert(gSearchTermLabels)
      .values(batch)
      .onConflictDoUpdate({
        target: [gSearchTermLabels.accountId, gSearchTermLabels.termHash, gSearchTermLabels.profileVersion],
        set: { intent: sql`excluded.intent`, relevant: sql`excluded.relevant`, confidence: sql`excluded.confidence`, reason: sql`excluded.reason`, model: sql`excluded.model`, updatedAt: sql`now()` },
      })
      .returning({ id: gSearchTermLabels.id }),
  );
}
