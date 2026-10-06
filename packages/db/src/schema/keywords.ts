import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, unique, uuid } from 'drizzle-orm/pg-core';
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
