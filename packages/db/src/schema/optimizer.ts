import { date, integer, jsonb, numeric, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { changesets } from './changesets';
import { id, timestamps } from './columns';
import { orgs } from './identity';
import { adAccounts, entities } from './platform';

// Google budget simulation per campaign, refreshed daily (ADR-0018 marginal input).
export const gBudgetSimulations = pgTable(
  'g_budget_simulations',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => adAccounts.id),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => entities.id),
    // [{ budgetMicros, costMicros, clicks, conversions, convValue }]
    points: jsonb('points').notNull(),
    fetchedOn: date('fetched_on', { mode: 'string' }).notNull(),
    ...timestamps,
  },
  (t) => [unique('g_budget_simulations_campaign_key').on(t.campaignId)],
);

// One optimizer computation (ADR-0018): its inputs, so a proposal can recompute the same plan
// with exclusions, and the result the agent saw. Proposals reference it by id only.
export const optimizerRuns = pgTable('optimizer_runs', {
  id: id(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id),
  accountId: uuid('account_id')
    .notNull()
    .references(() => adAccounts.id),
  // OptimizerCampaign[]
  inputs: jsonb('inputs').notNull(),
  // ReallocationPlan
  plan: jsonb('plan').notNull(),
  maxChangePct: numeric('max_change_pct', { precision: 6, scale: 4, mode: 'number' }).notNull(),
  minConversions: integer('min_conversions').notNull(),
  changesetId: uuid('changeset_id').references(() => changesets.id),
  usedAt: timestamp('used_at', { withTimezone: true }),
  ...timestamps,
});
