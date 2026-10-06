import { sql } from 'drizzle-orm';
import { check, date, index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns';
import { orgs } from './identity';
import { adAccounts, entities } from './platform';

// Detected anomalies (ADR-0021, Requirement 16.4); the audit agent explains them later.
export const anomalies = pgTable(
  'anomalies',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => adAccounts.id),
    // null = account level.
    entityId: uuid('entity_id').references(() => entities.id),
    // entity_id as text, '' at account level: lets the unique key treat account level as a value.
    entityKey: text('entity_key').notNull().default(''),
    detectedOn: date('detected_on', { mode: 'string' }).notNull(),
    metric: text('metric').notNull(),
    // Segment key for geo / placement anomalies; '' otherwise (part of the unique key).
    segment: text('segment').notNull().default(''),
    value: numeric('value', { precision: 24, scale: 6, mode: 'number' }).notNull(),
    baseline: numeric('baseline', { precision: 24, scale: 6, mode: 'number' }).notNull(),
    z: numeric('z', { precision: 12, scale: 4, mode: 'number' }).notNull(),
    direction: text('direction').notNull(),
    details: jsonb('details').notNull().default({}),
    // Audit agent's ranked causes, once explained.
    explanation: text('explanation'),
    explainedAt: timestamp('explained_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('anomalies_key').on(t.accountId, t.entityKey, t.detectedOn, t.metric, t.segment),
    index('anomalies_account_detected_idx').on(t.accountId, t.detectedOn),
    check('anomalies_direction', sql`${t.direction} in ('up', 'down')`),
  ],
);
