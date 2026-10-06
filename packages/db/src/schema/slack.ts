import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orgs } from './identity';

// Slack retries events it did not see acked; each event_id is processed once
// (design.md「Error Handling」). Rows older than a day are pruned.
export const slackEventsSeen = pgTable(
  'slack_events_seen',
  {
    eventId: text('event_id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('slack_events_seen_seen_at_idx').on(t.seenAt)],
);
