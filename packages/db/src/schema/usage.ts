import { bigint, index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns';
import { orgs } from './identity';

// Token usage and estimated cost per agent × model per run (Requirement 19.2, ADR-0023).
export const llmUsage = pgTable(
  'llm_usage',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    agent: text('agent').notNull(),
    model: text('model').notNull(),
    requests: bigint('requests', { mode: 'number' }).notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    cachedInputTokens: bigint('cached_input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }).notNull().default(0),
    // What the run was for: session (Slack thread), job_run, campaign_task, changeset.
    refKind: text('ref_kind').notNull(),
    refId: text('ref_id').notNull(),
    traceId: text('trace_id'),
    ...timestamps,
  },
  (t) => [index('llm_usage_at_idx').on(t.at), index('llm_usage_ref_idx').on(t.refKind, t.refId)],
);
