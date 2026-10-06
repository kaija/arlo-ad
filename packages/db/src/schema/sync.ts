import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from './columns';
import { orgs } from './identity';
import { adAccounts } from './platform';

// Per account × sync job bookkeeping (ADR-0003): last success for healthz and dashboards,
// consecutive failures for ops alerts (Requirement 2.6).
export const SYNC_JOBS = ['sync.snapshots', 'sync.hourly', 'sync.daily'] as const;

export const syncState = pgTable(
  'sync_state',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => adAccounts.id),
    job: text('job').notNull(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    // Error code or short message; never credentials.
    lastError: text('last_error'),
    // When the ops channel was last alerted for the current failure streak.
    alertedAt: timestamp('alerted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: 'sync_state_pk', columns: [t.accountId, t.job] }),
    check('sync_state_failures_non_negative', sql`${t.consecutiveFailures} >= 0`),
  ],
);
