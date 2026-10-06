import { bigint, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from './columns';
import { orgs } from './identity';

// Agent SDK sessions (ADR-0015): one per Slack thread, id `slack:{channel}:{thread_ts}`.
export const agentSessions = pgTable('agent_sessions', {
  id: text('id').primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id),
  // Last Slack message already folded into the session; later ones are added as a delta.
  lastSlackTs: text('last_slack_ts'),
  // Condensed history of items dropped by truncation.
  summary: text('summary'),
  ...timestamps,
});

export const agentSessionItems = pgTable(
  'agent_session_items',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    item: jsonb('item').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'agent_session_items_pk', columns: [t.sessionId, t.seq] })],
);
