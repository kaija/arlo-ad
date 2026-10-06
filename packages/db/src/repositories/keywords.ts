// Business Profiles (ADR-0019). Saving inserts the next version; reads take the latest.
import { createHash } from 'node:crypto';
import { BusinessProfileSchema, normalizeSearchTerm, withExample, type BusinessProfile, type ProfileExample, type SearchTermLabel } from '@arlo/core';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { businessProfiles, changesets, DEFAULT_ORG_ID, entities, gSearchTermLabels, gSearchTerms } from '../schema';
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
export function addProfileExample(db: Db, accountId: string, example: ProfileExample, actor: Actor): Promise<StoredProfile> {
  return addProfileExamples(db, accountId, [example], actor);
}

/** Several labelled terms in one new version. */
export async function addProfileExamples(db: Db, accountId: string, examples: readonly ProfileExample[], actor: Actor): Promise<StoredProfile> {
  const current = await getBusinessProfile(db, accountId);
  const base: BusinessProfile = current?.profile ?? { offerings: [], targetIntents: [], excludedIntents: [], brandTerms: [], competitorPolicy: 'review', examples: [] };
  return saveBusinessProfile(db, accountId, examples.reduce(withExample, base), actor);
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

// --- negative keyword sweep (Requirements 14.4, 14.5) ---------------------------------------

export interface SearchTermStat {
  /** Normalized term. */
  term: string;
  costMicros: number;
  clicks: number;
  impressions: number;
  /** Conversions over the longer window (90 days for the auto condition). */
  conversions: number;
  /** Campaign entity ids the term spent in. */
  campaignIds: string[];
}

/** Per-term totals: cost / clicks / impressions since `costFrom`, conversions since `convFrom`. */
export async function searchTermStats(db: DbOrTx, accountId: string, opts: { costFrom: string; convFrom: string; to: string; limit?: number }): Promise<SearchTermStat[]> {
  const norm = sql<string>`lower(regexp_replace(trim(${gSearchTerms.term}), '\\s+', ' ', 'g'))`;
  const rows = await db
    .select({
      term: norm,
      costMicros: sql<number>`coalesce(sum(${gSearchTerms.costMicros}) filter (where ${gSearchTerms.date} >= ${opts.costFrom}), 0)`.mapWith(Number),
      clicks: sql<number>`coalesce(sum(${gSearchTerms.clicks}) filter (where ${gSearchTerms.date} >= ${opts.costFrom}), 0)`.mapWith(Number),
      impressions: sql<number>`coalesce(sum(${gSearchTerms.impressions}) filter (where ${gSearchTerms.date} >= ${opts.costFrom}), 0)`.mapWith(Number),
      conversions: sql<number>`coalesce(sum(${gSearchTerms.conversions}), 0)`.mapWith(Number),
      campaignIds: sql<string[]>`array_agg(distinct ${gSearchTerms.campaignId}::text)`,
    })
    .from(gSearchTerms)
    .where(and(eq(gSearchTerms.accountId, accountId), sql`${gSearchTerms.date} >= ${opts.convFrom}`, sql`${gSearchTerms.date} <= ${opts.to}`))
    .groupBy(norm)
    .orderBy(desc(sql`coalesce(sum(${gSearchTerms.costMicros}) filter (where ${gSearchTerms.date} >= ${opts.costFrom}), 0)`))
    .limit(opts.limit ?? 2000);
  return rows;
}

/**
 * Normalized texts of negative keywords already proposed for the account and not dropped
 * (anything except FAILED / STALE / EXPIRED / BLOCKED), so sweeps do not repeat themselves.
 */
export async function proposedNegativeTerms(db: DbOrTx, accountId: string): Promise<Set<string>> {
  const rows = await db.execute<{ text: string }>(sql`
    select distinct lower(regexp_replace(trim(op->'after'->>'text'), '\\s+', ' ', 'g')) as text
    from ${changesets}, jsonb_array_elements(${changesets.ops}) as op
    where ${changesets.accountId} = ${accountId}
      and ${changesets.status} not in ('FAILED', 'STALE', 'EXPIRED', 'BLOCKED')
      and op->>'kind' = 'google.add_negative_keyword'
      and op->'after'->>'text' is not null`);
  return new Set(rows.rows.map((r) => r.text));
}

/** The account's shared negative list with this name (synced as a shared_set entity). */
export async function findSharedSet(db: DbOrTx, accountId: string, name: string): Promise<{ id: string; externalId: string } | undefined> {
  const [row] = await db
    .select({ id: entities.id, externalId: entities.externalId })
    .from(entities)
    .where(and(eq(entities.accountId, accountId), eq(entities.kind, 'shared_set'), eq(entities.name, name), sql`${entities.status} is distinct from 'REMOVED'`));
  return row;
}
