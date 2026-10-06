import { AUTOMATION_MODES } from '@arlo/core';
import { pgEnum, pgTable, unique, uuid } from 'drizzle-orm/pg-core';
import { automationFeature } from './changesets';
import { id, timestamps } from './columns';
import { orgs, users } from './identity';
import { adAccounts } from './platform';

// Automation mode per account × feature (ADR-0013, Requirement 9.1). No row means the default,
// shadow (Requirement 9.2), so new accounts never start live.
export const automationMode = pgEnum('automation_mode', AUTOMATION_MODES);

export const automationModes = pgTable(
  'automation_modes',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => adAccounts.id),
    feature: automationFeature('feature').notNull(),
    mode: automationMode('mode').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
    ...timestamps,
  },
  (t) => [unique('automation_modes_account_feature_key').on(t.accountId, t.feature)],
);
