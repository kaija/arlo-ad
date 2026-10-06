import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns';
import { orgs, users } from './identity';

// Scheduled job templates (ADR-0016, Requirement 11.1).
export const JOB_TEMPLATES = ['daily_report', 'negative_kw_sweep', 'budget_rebalance', 'tracking_audit', 'anomaly_watch', 'custom_prompt'] as const;
export const jobTemplate = pgEnum('job_template', JOB_TEMPLATES);

export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    name: text('name').notNull(),
    template: jobTemplate('template').notNull(),
    // Standard 5-field cron, evaluated in `tz` by pg-boss.
    cron: text('cron').notNull(),
    tz: text('tz').notNull().default('Asia/Taipei'),
    // ad_accounts.id; null = every active account.
    accountIds: uuid('account_ids').array(),
    // ConversationRef the results are posted to (Requirement 11.2).
    target: jsonb('target').notNull(),
    extraInstructions: text('extra_instructions'),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    ...timestamps,
  },
  (t) => [check('scheduled_jobs_account_ids_not_empty', sql`${t.accountIds} is null or cardinality(${t.accountIds}) > 0`)],
);

export const JOB_RUN_STATUSES = ['running', 'succeeded', 'failed', 'skipped'] as const;
export const jobRunStatus = pgEnum('job_run_status', JOB_RUN_STATUSES);

// One row per execution (Requirement 11.4).
export const jobRuns = pgTable(
  'job_runs',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    scheduledJobId: uuid('scheduled_job_id').references(() => scheduledJobs.id, { onDelete: 'set null' }),
    template: jobTemplate('template').notNull(),
    // schedule | manual
    trigger: text('trigger').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: jobRunStatus('status').notNull().default('running'),
    // { messages: ChatMessage[], changesetIds: string[] } or the skip reason.
    output: jsonb('output'),
    error: text('error'),
    traceId: text('trace_id'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }),
    ...timestamps,
  },
  (t) => [index('job_runs_scheduled_job_started_idx').on(t.scheduledJobId, t.startedAt)],
);
