// ChangeSet: the only way a write reaches an ad platform (ADR-0006, Requirements 3.2–3.7).
import type { ConversationRef } from '../chat/messages';
import type { Op, Platform } from '../platform/types';

export const CHANGESET_STATUSES = [
  'PENDING_VALIDATION',
  'BLOCKED',
  'PENDING_APPROVAL',
  'APPROVED',
  'EXECUTING',
  'EXECUTED',
  'FAILED',
  'REJECTED',
  'STALE',
  'EXPIRED',
  'SIMULATED',
  'REVERTED',
] as const;
export type ChangeSetStatus = (typeof CHANGESET_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<ChangeSetStatus> = new Set(['BLOCKED', 'FAILED', 'REJECTED', 'STALE', 'EXPIRED', 'SIMULATED', 'REVERTED']);

export type Tier = 0 | 1 | 2 | 3;

/** Automations whose Tier 1 actions follow an off / shadow / live mode (ADR-0013). */
export const AUTOMATION_FEATURES = ['negative_kw_auto', 'circuit_breaker', 'bid_auto_reduce', 'budget_rebalance'] as const;
export type AutomationFeature = (typeof AUTOMATION_FEATURES)[number];

/** off: the automation proposes nothing; shadow: validate and tier, never mutate; live: execute. */
export const AUTOMATION_MODES = ['off', 'shadow', 'live'] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];
/** New accounts start every automation in shadow (Requirement 9.2). */
export const DEFAULT_AUTOMATION_MODE: AutomationMode = 'shadow';

export const CHANGESET_SOURCES = ['chat', 'schedule', 'monitor', 'web', 'undo'] as const;
export type ChangeSetSourceKind = (typeof CHANGESET_SOURCES)[number];

export interface ChangeSetSource {
  kind: ChangeSetSourceKind;
  ref?: ConversationRef;
  jobRunId?: string;
  monitorRuleId?: string;
}

export type Severity = 'HARD_BLOCK' | 'WARN';

export interface Violation {
  /** Rule instance id, or a system code such as MISSING_CONTEXT. */
  ruleId: string;
  ruleType: string;
  severity: Severity;
  /** Index of the offending op; absent when the whole ChangeSet violates the rule. */
  opIndex?: number;
  message: string;
  /** Numbers behind the decision, for the approval card and audit. */
  details?: Record<string, number | string | null>;
}

export interface ChangeSet {
  id: string;
  orgId: string;
  platform: Platform;
  /** Internal ad_accounts.id. Op targets carry the platform account id. */
  accountId: string;
  feature?: AutomationFeature | null;
  source: ChangeSetSource;
  ops: Op[];
  summary: string;
  rationale?: string | null;
  tier: Tier | null;
  status: ChangeSetStatus;
  violations: Violation[];
  requestedBy: { kind: 'user' | 'agent' | 'system'; userId?: string | null };
  approvedBy?: string | null;
  expiresAt?: Date | null;
  revertOf?: string | null;
  traceId?: string | null;
  /** Ops the approver excluded from a batch; they are never executed (Requirement 14.5). */
  excludedOps?: number[];
  createdAt: Date;
  executedAt?: Date | null;
}
