import { DEFAULT_COOLDOWN_MINUTES } from '@arlo/core';
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { changesets } from './changesets';
import { id, timestamps } from './columns';
import { orgs, users } from './identity';
import { adAccounts, entities } from './platform';

// Monitor rules (ADR-0017, Requirement 12.2): MonitorRuleSpec + MonitorAction, per account or
// one campaign of it, with a cooldown per (rule, entity).
export const monitorRules = pgTable(
  'monitor_rules',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => adAccounts.id),
    // null = every enabled campaign of the account.
    campaignEntityId: uuid('campaign_entity_id').references(() => entities.id),
    spec: jsonb('spec').notNull(),
    action: jsonb('action').notNull(),
    cooldownMinutes: integer('cooldown_minutes').notNull().default(DEFAULT_COOLDOWN_MINUTES),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    ...timestamps,
  },
  (t) => [index('monitor_rules_account_idx').on(t.accountId), check('monitor_rules_cooldown', sql`${t.cooldownMinutes} between 0 and 10080`)],
);

// Every time a rule fired for an entity (Requirement 12.4: cooldown source of truth).
export const monitorFirings = pgTable(
  'monitor_firings',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    monitorRuleId: uuid('monitor_rule_id')
      .notNull()
      .references(() => monitorRules.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    firedAt: timestamp('fired_at', { withTimezone: true }).notNull(),
    changesetId: uuid('changeset_id').references(() => changesets.id),
    evidence: jsonb('evidence').notNull().default({}),
    ...timestamps,
  },
  (t) => [index('monitor_firings_rule_entity_fired_idx').on(t.monitorRuleId, t.entityId, t.firedAt)],
);
