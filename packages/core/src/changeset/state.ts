// ChangeSet state machine (design.md flow 3). transition() is pure; the DB applies the result
// with a compare-and-set on the previous status.
import type { ChangeSet, ChangeSetStatus, Tier, Violation } from './types';

export type ChangeSetEvent =
  | { type: 'block'; violations: Violation[] }
  | { type: 'simulate'; tier: Tier; violations?: Violation[] }
  | { type: 'auto_execute'; tier: Tier; violations?: Violation[] }
  | { type: 'request_approval'; tier: Tier; violations?: Violation[]; expiresAt: Date }
  | { type: 'approve'; by: string }
  | { type: 'reject'; by: string; reason?: string }
  | { type: 'expire' }
  | { type: 'stale' }
  | { type: 'execute' }
  | { type: 'executed'; at: Date }
  | { type: 'fail' }
  | { type: 'revert' };

export type ChangeSetEventType = ChangeSetEvent['type'];

/** Legal events per status → next status. */
export const TRANSITIONS: Readonly<Record<ChangeSetStatus, Partial<Record<ChangeSetEventType, ChangeSetStatus>>>> = {
  PENDING_VALIDATION: { block: 'BLOCKED', simulate: 'SIMULATED', auto_execute: 'EXECUTING', request_approval: 'PENDING_APPROVAL' },
  PENDING_APPROVAL: { approve: 'APPROVED', reject: 'REJECTED', expire: 'EXPIRED' },
  // Re-validation after approval can still block (Requirement 6.4).
  APPROVED: { stale: 'STALE', block: 'BLOCKED', execute: 'EXECUTING' },
  EXECUTING: { executed: 'EXECUTED', fail: 'FAILED' },
  EXECUTED: { revert: 'REVERTED' },
  BLOCKED: {},
  SIMULATED: {},
  REJECTED: {},
  EXPIRED: {},
  STALE: {},
  FAILED: {},
  REVERTED: {},
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: ChangeSetStatus,
    readonly event: ChangeSetEventType,
  ) {
    super(`ChangeSet cannot ${event} from ${from}`);
    this.name = 'IllegalTransitionError';
  }
}

export function nextStatus(from: ChangeSetStatus, event: ChangeSetEventType): ChangeSetStatus | null {
  return TRANSITIONS[from][event] ?? null;
}

export function transition(cs: ChangeSet, event: ChangeSetEvent): ChangeSet {
  const status = nextStatus(cs.status, event.type);
  if (!status) throw new IllegalTransitionError(cs.status, event.type);
  const next: ChangeSet = { ...cs, status };
  switch (event.type) {
    case 'block':
      next.violations = event.violations;
      break;
    case 'simulate':
    case 'auto_execute':
      next.tier = event.tier;
      next.violations = event.violations ?? cs.violations;
      break;
    case 'request_approval':
      next.tier = event.tier;
      next.violations = event.violations ?? cs.violations;
      next.expiresAt = event.expiresAt;
      break;
    case 'approve':
      next.approvedBy = event.by;
      break;
    case 'executed':
      next.executedAt = event.at;
      break;
  }
  return next;
}
