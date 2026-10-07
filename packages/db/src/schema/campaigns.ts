import { CAMPAIGN_TASK_STATUSES } from '@arlo/core';
import { index, integer, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { changesets } from './changesets';
import { id, timestamps } from './columns';
import { orgs, users } from './identity';
import { adAccounts } from './platform';

// Campaign creation from a brief (ADR-0020, Requirements 15.1, 15.8).
export const campaignTaskStatus = pgEnum('campaign_task_status', CAMPAIGN_TASK_STATUSES);

export const campaignTasks = pgTable(
  'campaign_tasks',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => adAccounts.id),
    // CampaignBrief
    brief: jsonb('brief').notNull(),
    status: campaignTaskStatus('status').notNull().default('queued'),
    createdBy: uuid('created_by').references(() => users.id),
    traceId: text('trace_id'),
    error: text('error'),
    ...timestamps,
  },
  (t) => [index('campaign_tasks_account_idx').on(t.accountId, t.createdAt)],
);

// Every version of a task's draft: agent output, edits and regenerated sections (Requirement 15.4).
export const campaignDrafts = pgTable(
  'campaign_drafts',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => campaignTasks.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    // CampaignDraft
    draft: jsonb('draft').notNull(),
    lintIssues: jsonb('lint_issues').notNull().default([]),
    // What produced this version: generate / edit / regenerate:<section>.
    origin: text('origin').notNull(),
    // Google policy review per created ad (Requirement 15.7), filled after creation.
    policyStatus: jsonb('policy_status'),
    changesetId: uuid('changeset_id').references(() => changesets.id),
    createdBy: uuid('created_by').references(() => users.id),
    ...timestamps,
  },
  (t) => [unique('campaign_drafts_task_version_key').on(t.taskId, t.version)],
);
