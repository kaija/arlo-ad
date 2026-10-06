import { AUTOMATION_FEATURES, CHANGESET_SOURCES, CHANGESET_STATUSES } from '@arlo/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  bigint,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns';
import { orgs, users } from './identity';
import { adAccounts, entities, platform } from './platform';

// ChangeSets, their execution results, chat cards and the audit trail (ADR-0006).

const orgId = () =>
  uuid('org_id')
    .notNull()
    .references(() => orgs.id);

export const changesetStatus = pgEnum('changeset_status', CHANGESET_STATUSES);
export const changesetSource = pgEnum('changeset_source', CHANGESET_SOURCES);
export const automationFeature = pgEnum('automation_feature', AUTOMATION_FEATURES);

export const changesets = pgTable(
  'changesets',
  {
    id: id(),
    orgId: orgId(),
    platform: platform('platform').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => adAccounts.id),
    feature: automationFeature('feature'),
    sourceKind: changesetSource('source_kind').notNull(),
    // { kind, ref?: ConversationRef, jobRunId?, monitorRuleId? } (Requirement 3.7)
    source: jsonb('source').notNull(),
    // Op[] with target, field, before, after (Requirement 3.2)
    ops: jsonb('ops').notNull(),
    summary: text('summary').notNull(),
    rationale: text('rationale'),
    tier: smallint('tier'),
    status: changesetStatus('status').notNull().default('PENDING_VALIDATION'),
    violations: jsonb('violations').notNull().default([]),
    // Why the ChangeSet is in its status: reject reason, drift, failure (shown on cards).
    statusReason: text('status_reason'),
    requestedByKind: text('requested_by_kind').notNull(),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id),
    approvedBy: uuid('approved_by').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revertOf: uuid('revert_of'),
    traceId: text('trace_id'),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    // Approval SLA reminder sent (Requirement 7.5: once per ChangeSet).
    slaRemindedAt: timestamp('sla_reminded_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('changesets_status_idx').on(t.status),
    index('changesets_account_created_idx').on(t.accountId, t.createdAt),
    foreignKey({ name: 'changesets_revert_of_fk', columns: [t.revertOf], foreignColumns: [t.id] }),
    // At most one live Undo per ChangeSet (ADR-0012); a failed attempt can be retried.
    uniqueIndex('changesets_one_active_revert')
      .on(t.revertOf)
      .where(sql`${t.revertOf} is not null and ${t.status} not in ('FAILED', 'STALE', 'BLOCKED')`),
    check('changesets_tier_range', sql`${t.tier} is null or ${t.tier} between 0 and 3`),
    check('changesets_requested_by_kind', sql`${t.requestedByKind} in ('user', 'agent', 'system')`),
    check('changesets_ops_array', sql`jsonb_typeof(${t.ops}) = 'array'`),
  ],
);

// One result per op once executed (Requirement 3.5).
export const changesetOpResults = pgTable(
  'changeset_op_results',
  {
    orgId: orgId(),
    changesetId: uuid('changeset_id')
      .notNull()
      .references(() => changesets.id),
    opIndex: integer('op_index').notNull(),
    ok: boolean('ok').notNull(),
    error: text('error'),
    resourceName: text('resource_name'),
    ...timestamps,
  },
  (t) => [primaryKey({ name: 'changeset_op_results_pk', columns: [t.changesetId, t.opIndex] })],
);

export const APPROVAL_MESSAGE_KINDS = ['origin', 'mirror', 'notice'] as const;
export const approvalMessageKind = pgEnum('approval_message_kind', APPROVAL_MESSAGE_KINDS);

// Every chat card showing a ChangeSet, so all of them update together (Requirement 7.4).
export const approvalMessages = pgTable(
  'approval_messages',
  {
    id: id(),
    orgId: orgId(),
    changesetId: uuid('changeset_id')
      .notNull()
      .references(() => changesets.id),
    platform: text('platform').notNull().default('slack'),
    channelId: text('channel_id').notNull(),
    messageId: text('message_id').notNull(),
    threadId: text('thread_id'),
    kind: approvalMessageKind('kind').notNull(),
    ...timestamps,
  },
  (t) => [unique('approval_messages_channel_message_key').on(t.channelId, t.messageId), index('approval_messages_changeset_idx').on(t.changesetId)],
);

// Append-only (Requirement 3.6): a trigger rejects UPDATE, DELETE and TRUNCATE.
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    orgId: orgId(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id'),
    entityKind: text('entity_kind').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    payload: jsonb('payload'),
  },
  (t) => [index('audit_log_entity_idx').on(t.entityKind, t.entityId, t.at)],
);

// --- validator rules and tier thresholds (ADR-0007, ADR-0008) ---------------------------

export const RULE_SCOPES = ['org', 'account', 'campaign'] as const;
export const ruleScope = pgEnum('rule_scope', RULE_SCOPES);
export const SEVERITIES = ['HARD_BLOCK', 'WARN'] as const;
export const severity = pgEnum('rule_severity', SEVERITIES);

export const rules = pgTable(
  'rules',
  {
    id: id(),
    orgId: orgId(),
    scopeKind: ruleScope('scope_kind').notNull(),
    accountId: uuid('account_id').references(() => adAccounts.id),
    campaignEntityId: uuid('campaign_entity_id').references(() => entities.id),
    // RuleSpec, validated with RuleSpecSchema on write.
    spec: jsonb('spec').notNull(),
    severity: severity('severity').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id),
    ...timestamps,
  },
  (t) => [
    check(
      'rules_scope_consistent',
      sql`(${t.scopeKind} = 'org' and ${t.accountId} is null and ${t.campaignEntityId} is null)
        or (${t.scopeKind} = 'account' and ${t.accountId} is not null and ${t.campaignEntityId} is null)
        or (${t.scopeKind} = 'campaign' and ${t.accountId} is not null and ${t.campaignEntityId} is not null)`,
    ),
  ],
);

export const tierThresholds = pgTable(
  'tier_thresholds',
  {
    id: id(),
    orgId: orgId(),
    // null = org-wide default; an account row overrides it.
    accountId: uuid('account_id').references(() => adAccounts.id),
    tier3Pct: numeric('tier3_pct', { precision: 6, scale: 4, mode: 'number' }).notNull(),
    tier3AmountMicros: bigint('tier3_amount_micros', { mode: 'number' }),
    tier1MaxReducePct: numeric('tier1_max_reduce_pct', { precision: 6, scale: 4, mode: 'number' }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('tier_thresholds_org_default_key').on(t.orgId).where(sql`${t.accountId} is null`),
    uniqueIndex('tier_thresholds_account_key').on(t.orgId, t.accountId).where(sql`${t.accountId} is not null`),
    check('tier_thresholds_pcts', sql`${t.tier3Pct} > 0 and ${t.tier1MaxReducePct} >= 0 and ${t.tier1MaxReducePct} <= 1`),
  ],
);
