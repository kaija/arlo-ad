import { AUTOMATION_MODES } from '@arlo/core';
import { index, pgEnum, pgTable, unique, uuid } from 'drizzle-orm/pg-core';
import { automationFeature, changesets } from './changesets';
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

export const SHADOW_VERDICTS = ['up', 'down'] as const;
export const shadowVerdict = pgEnum('shadow_verdict', SHADOW_VERDICTS);

// 👍/👎 on SIMULATED ChangeSets (Requirement 9.4); one vote per user, the latest counts.
export const shadowFeedback = pgTable(
  'shadow_feedback',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    changesetId: uuid('changeset_id')
      .notNull()
      .references(() => changesets.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    verdict: shadowVerdict('verdict').notNull(),
    ...timestamps,
  },
  (t) => [unique('shadow_feedback_changeset_user_key').on(t.changesetId, t.userId), index('shadow_feedback_changeset_idx').on(t.changesetId)],
);
