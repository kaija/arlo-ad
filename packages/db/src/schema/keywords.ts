import { sql } from 'drizzle-orm';
import { SEARCH_INTENTS } from '@arlo/core';
import { boolean, check, integer, jsonb, numeric, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns';
import { orgs, users } from './identity';
import { adAccounts } from './platform';

// Business Profile per account (ADR-0019, Requirement 14.1). Append-only: every edit inserts the
// next version, so classifications cached by (term, profile_version) stay attributable.
export const businessProfiles = pgTable(
  'business_profiles',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => adAccounts.id),
    version: integer('version').notNull(),
    // BusinessProfile (offerings, target_intents, excluded_intents, brand_terms, competitor_policy, examples).
    profile: jsonb('profile').notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    ...timestamps,
  },
  (t) => [unique('business_profiles_account_version_key').on(t.accountId, t.version), check('business_profiles_version_positive', sql`${t.version} > 0`)],
);

export const searchIntent = pgEnum('search_intent', SEARCH_INTENTS);

// Classifier output cache (Requirement 14.3): one label per (account, term, profile version), so
// an unchanged profile never pays to classify the same term twice.
export const gSearchTermLabels = pgTable(
  'g_search_term_labels',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => adAccounts.id),
    // sha256 of the normalized term.
    termHash: text('term_hash').notNull(),
    term: text('term').notNull(),
    profileVersion: integer('profile_version').notNull(),
    intent: searchIntent('intent').notNull(),
    relevant: boolean('relevant').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    model: text('model'),
    ...timestamps,
  },
  (t) => [
    unique('g_search_term_labels_key').on(t.accountId, t.termHash, t.profileVersion),
    check('g_search_term_labels_confidence', sql`${t.confidence} between 0 and 1`),
  ],
);
