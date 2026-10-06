import { describe, expect, it } from 'vitest';
import { IllegalTransitionError, nextStatus, transition, TRANSITIONS, type ChangeSetEvent, type ChangeSetEventType } from './state';
import { CHANGESET_STATUSES, TERMINAL_STATUSES, type ChangeSet, type ChangeSetStatus } from './types';

const base: ChangeSet = {
  id: 'cs-1',
  orgId: 'org',
  platform: 'google_ads',
  accountId: 'acc',
  source: { kind: 'chat' },
  ops: [],
  summary: 's',
  tier: null,
  status: 'PENDING_VALIDATION',
  violations: [],
  requestedBy: { kind: 'user', userId: 'u1' },
  createdAt: new Date('2026-10-06T00:00:00Z'),
};

const warn = { ruleId: 'r1', ruleType: 'MaxChangePct', severity: 'WARN' as const, message: 'm' };
const events: Record<ChangeSetEventType, ChangeSetEvent> = {
  block: { type: 'block', violations: [{ ...warn, severity: 'HARD_BLOCK' }] },
  simulate: { type: 'simulate', tier: 1 },
  auto_execute: { type: 'auto_execute', tier: 1 },
  request_approval: { type: 'request_approval', tier: 2, violations: [warn], expiresAt: new Date('2026-10-07T00:00:00Z') },
  approve: { type: 'approve', by: 'u2' },
  reject: { type: 'reject', by: 'u2', reason: 'no' },
  expire: { type: 'expire' },
  stale: { type: 'stale' },
  execute: { type: 'execute' },
  executed: { type: 'executed', at: new Date('2026-10-06T01:00:00Z') },
  fail: { type: 'fail' },
  revert: { type: 'revert' },
};

// The design's state diagram, written out independently of TRANSITIONS.
const LEGAL: [ChangeSetStatus, ChangeSetEventType, ChangeSetStatus][] = [
  ['PENDING_VALIDATION', 'block', 'BLOCKED'],
  // Tier 1 drift check before auto-execution (ADR-0009).
  ['PENDING_VALIDATION', 'stale', 'STALE'],
  ['PENDING_VALIDATION', 'simulate', 'SIMULATED'],
  ['PENDING_VALIDATION', 'auto_execute', 'EXECUTING'],
  ['PENDING_VALIDATION', 'request_approval', 'PENDING_APPROVAL'],
  ['PENDING_APPROVAL', 'approve', 'APPROVED'],
  ['PENDING_APPROVAL', 'reject', 'REJECTED'],
  ['PENDING_APPROVAL', 'expire', 'EXPIRED'],
  ['APPROVED', 'stale', 'STALE'],
  ['APPROVED', 'block', 'BLOCKED'],
  ['APPROVED', 'execute', 'EXECUTING'],
  ['EXECUTING', 'executed', 'EXECUTED'],
  ['EXECUTING', 'fail', 'FAILED'],
  ['EXECUTED', 'revert', 'REVERTED'],
];

describe('ChangeSet state machine', () => {
  it.each(LEGAL)('%s --%s--> %s', (from, event, to) => {
    expect(transition({ ...base, status: from }, events[event]).status).toBe(to);
  });

  const legal = new Set(LEGAL.map(([from, event]) => `${from}:${event}`));
  const illegal = CHANGESET_STATUSES.flatMap((from) =>
    (Object.keys(events) as ChangeSetEventType[]).filter((e) => !legal.has(`${from}:${e}`)).map((e) => [from, e] as const),
  );

  it.each(illegal)('rejects %s --%s', (from, event) => {
    expect(nextStatus(from, event)).toBeNull();
    expect(() => transition({ ...base, status: from }, events[event])).toThrow(IllegalTransitionError);
  });

  it('matches the transition table exactly', () => {
    const table = Object.entries(TRANSITIONS).flatMap(([from, map]) => Object.entries(map).map(([e, to]) => [from, e, to]));
    expect(table.sort()).toEqual(LEGAL.map((l) => [...l]).sort());
  });

  it('has no way out of terminal states', () => {
    for (const s of TERMINAL_STATUSES) expect(TRANSITIONS[s]).toEqual({});
  });

  it('records tier, violations, expiry, approver and execution time', () => {
    const pending = transition(base, events.request_approval);
    expect(pending).toMatchObject({ status: 'PENDING_APPROVAL', tier: 2, violations: [warn], expiresAt: new Date('2026-10-07T00:00:00Z') });
    const approved = transition(pending, events.approve);
    expect(approved.approvedBy).toBe('u2');
    const executed = transition(transition(approved, events.execute), events.executed);
    expect(executed).toMatchObject({ status: 'EXECUTED', executedAt: new Date('2026-10-06T01:00:00Z') });
    expect(transition(base, events.block).violations[0]!.severity).toBe('HARD_BLOCK');
    expect(transition(base, events.simulate)).toMatchObject({ status: 'SIMULATED', tier: 1 });
    // Pure: the input is not modified.
    expect(base.status).toBe('PENDING_VALIDATION');
  });
});
