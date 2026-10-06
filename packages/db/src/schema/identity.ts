import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgEnum, pgTable, primaryKey, smallint, text, unique, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns';

// v1 is a single internal org (ADR-0001); every table still carries org_id (Requirement 1.7).
// Seeded by migration 0001_seed_default_org.
export const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';

const orgId = () =>
  uuid('org_id')
    .notNull()
    .references(() => orgs.id);

export const orgs = pgTable('orgs', {
  id: id(),
  name: text('name').notNull(),
  ...timestamps,
});

// unbound: no Slack user resolved yet (Requirement 1.3); disabled: may not sign in or act.
export const USER_STATUSES = ['active', 'unbound', 'disabled'] as const;
export const userStatus = pgEnum('user_status', USER_STATUSES);

export const users = pgTable(
  'users',
  {
    id: id(),
    orgId: orgId(),
    googleEmail: text('google_email').notNull(),
    slackUserId: text('slack_user_id'),
    displayName: text('display_name'),
    status: userStatus('status').notNull().default('unbound'),
    ...timestamps,
  },
  (t) => [
    unique('users_org_google_email_key').on(t.orgId, t.googleEmail),
    unique('users_org_slack_user_id_key').on(t.orgId, t.slackUserId),
    check('users_google_email_lowercase', sql`${t.googleEmail} = lower(${t.googleEmail})`),
    // `unbound` means exactly "no Slack user"; a disabled user may be either.
    check(
      'users_status_matches_slack_binding',
      sql`${t.status} = 'disabled' or (${t.status} = 'active') = (${t.slackUserId} is not null)`,
    ),
  ],
);

// Ordered by privilege (ADR-0010).
export const ROLES = ['viewer', 'operator', 'approver', 'admin'] as const;
export const role = pgEnum('role', ROLES);

export const roleBindings = pgTable(
  'role_bindings',
  {
    id: id(),
    orgId: orgId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: role('role').notNull(),
    // Platform account IDs this binding covers; null means every account.
    accountIds: text('account_ids').array(),
    // Highest ChangeSet tier this binding may approve (Requirement 1.4).
    maxTier: smallint('max_tier').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index('role_bindings_user_id_idx').on(t.userId),
    check('role_bindings_max_tier_range', sql`${t.maxTier} between 0 and 3`),
    check('role_bindings_account_ids_not_empty', sql`${t.accountIds} is null or cardinality(${t.accountIds}) > 0`),
  ],
);

// Runtime-tunable settings, e.g. daily_llm_budget_usd, sla_minutes, default_ttl_hours.
export const settings = pgTable(
  'settings',
  {
    orgId: orgId(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.orgId, t.key] })],
);
