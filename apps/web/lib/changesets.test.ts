import type { Op } from '@arlo/core';
import { applyTransition, DEFAULT_ORG_ID, insertChangeSet, recordOpResults, upsertAdAccounts, upsertUserOnSignIn, type StoredChangeSet } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ArloSessionUser } from './auth-config';
import { availableActions, loadDetail, loadQueue, mayDecide, parseQueueFilter, traceUrl } from './changesets';

const NOW = new Date('2026-10-07T04:00:00Z');
const user = (role: ArloSessionUser['bindings'][number]['role'], maxTier: number, id = 'u-1', accountIds: string[] | null = null): ArloSessionUser => ({
  id,
  email: 'x@example.com',
  displayName: null,
  status: 'active',
  slackUserId: 'U1',
  bindings: [{ role, accountIds, maxTier }],
});

const cs = (over: Partial<StoredChangeSet>): StoredChangeSet => ({
  id: 'cs',
  orgId: 'org',
  platform: 'google_ads',
  accountId: 'acc',
  source: { kind: 'web' },
  ops: [{ kind: 'set_budget', target: { platform: 'google_ads', accountId: '1', kind: 'campaign', id: '1' }, field: 'budget_micros', before: 1, after: 2 }],
  summary: 's',
  tier: 2,
  status: 'PENDING_APPROVAL',
  violations: [],
  requestedBy: { kind: 'user', userId: 'u-req' },
  createdAt: NOW,
  statusReason: null,
  updatedAt: NOW,
  ...over,
});

describe('parseQueueFilter', () => {
  it('keeps known values only', () => {
    expect(parseQueueFilter({ status: 'PENDING_APPROVAL', tier: '3', account: 'a' })).toEqual({ status: 'PENDING_APPROVAL', tier: 3, account: 'a' });
    expect(parseQueueFilter({ status: 'NOPE', tier: '7', account: ['a', 'b'] })).toEqual({});
  });
});

describe('availableActions', () => {
  it.each([
    ['viewer', user('viewer', 0), cs({}), { approve: false, confirm: false, reject: false, undo: false }],
    ['approver within tier', user('approver', 2), cs({}), { approve: true, confirm: false, reject: true, undo: false }],
    ['approver on Tier 3', user('approver', 3), cs({ tier: 3 }), { approve: true, confirm: true, reject: true, undo: false }],
    ['requester on own Tier 3', user('approver', 3, 'u-req'), cs({ tier: 3 }), { approve: false, confirm: false, reject: true, undo: false }],
    ['operator on fresh EXECUTED', user('operator', 0), cs({ status: 'EXECUTED', executedAt: new Date(NOW.getTime() - 3_600_000) }), { approve: false, confirm: false, reject: false, undo: true }],
    ['operator after 24h', user('operator', 0), cs({ status: 'EXECUTED', executedAt: new Date(NOW.getTime() - 25 * 3_600_000) }), { approve: false, confirm: false, reject: false, undo: false }],
    ['operator out of scope', user('operator', 0, 'u-1', ['other']), cs({ status: 'EXECUTED', executedAt: NOW }), { approve: false, confirm: false, reject: false, undo: false }],
  ] as const)('%s', (_, u, c, expected) => {
    expect(availableActions(u, c, NOW)).toEqual(expected);
  });

  it('routes Tier 3 approval through confirm only', () => {
    expect(mayDecide(user('approver', 3), cs({ tier: 3 }), 'approve', NOW)).toBe(false);
    expect(mayDecide(user('approver', 3), cs({ tier: 3 }), 'confirm', NOW)).toBe(true);
    expect(mayDecide(user('approver', 2), cs({}), 'approve', NOW)).toBe(true);
  });
});

describe('review queue data', () => {
  const t = useTestDatabase();
  let tw: string;
  let us: string;
  let approver: string;
  let executed: string;

  beforeAll(async () => {
    const accounts = await upsertAdAccounts(t.db, [
      { orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' },
      { orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '2234567890', name: 'Arlo US', currency: 'USD', timezone: 'America/Los_Angeles' },
    ]);
    tw = accounts.find((a) => a.externalId === '1234567890')!.id;
    us = accounts.find((a) => a.externalId === '2234567890')!.id;
    approver = (await upsertUserOnSignIn(t.db, { email: 'bob@example.com', displayName: 'Bob' })).id;
    const op = (account: string): Op => ({ kind: 'set_budget', target: { platform: 'google_ads', accountId: account, kind: 'campaign', id: '111' }, field: 'budget_micros', before: 1_000_000_000, after: 1_200_000_000 });

    const a = await insertChangeSet(t.db, { accountId: tw, source: { kind: 'web' }, ops: [op('1234567890')], summary: 'TW raise', requestedBy: { kind: 'agent' }, traceId: 'trace_abc' });
    const pending = await applyTransition(t.db, a, { type: 'request_approval', tier: 2, expiresAt: NOW }, { kind: 'system' });
    const approved = await applyTransition(t.db, pending.ok ? pending.changeset : a, { type: 'approve', by: approver }, { kind: 'user', id: approver });
    const running = await applyTransition(t.db, approved.ok ? approved.changeset : a, { type: 'execute' }, { kind: 'user', id: approver });
    await recordOpResults(t.db, a.id, [{ index: 0, ok: true, resourceName: 'customers/1/campaignBudgets/9' }]);
    await applyTransition(t.db, running.ok ? running.changeset : a, { type: 'executed', at: NOW }, { kind: 'user', id: approver });
    executed = a.id;

    const b = await insertChangeSet(t.db, { accountId: us, source: { kind: 'chat' }, ops: [op('2234567890')], summary: 'US raise', requestedBy: { kind: 'agent' } });
    await applyTransition(t.db, b, { type: 'request_approval', tier: 3, expiresAt: NOW }, { kind: 'system' });
  });

  it('lists within scope and filters by status, tier and account', async () => {
    expect((await loadQueue(t.db, null, {})).rows.map((r) => r.cs.summary).sort()).toEqual(['TW raise', 'US raise']);
    expect((await loadQueue(t.db, [tw], {})).rows.map((r) => [r.cs.summary, r.accountName])).toEqual([['TW raise', 'Arlo TW']]);
    expect((await loadQueue(t.db, null, { tier: 3 })).rows.map((r) => r.cs.summary)).toEqual(['US raise']);
    expect((await loadQueue(t.db, null, { status: 'EXECUTED' })).rows.map((r) => r.cs.summary)).toEqual(['TW raise']);
    expect((await loadQueue(t.db, null, { account: us })).rows.map((r) => r.cs.summary)).toEqual(['US raise']);
    expect((await loadQueue(t.db, [tw], { account: us })).rows).toEqual([]);
  });

  it('loads detail with diff, approver, trace, op results and audit trail', async () => {
    const d = await loadDetail(t.db, executed, null);
    expect(d).toMatchObject({
      approver: 'Bob',
      traceUrl: traceUrl('trace_abc'),
      opResults: [{ opIndex: 0, ok: true }],
      view: { ops: [{ label: 'Campaign 111 · 每日預算', before: 'NT$1,000', after: 'NT$1,200', change: '+20.0%' }] },
    });
    expect(d!.audit.map((a) => [a.action, a.actor])).toEqual([
      ['create', 'Arlo'],
      ['request_approval', null],
      ['approve', 'Bob'],
      ['execute', 'Bob'],
      ['executed', 'Bob'],
    ]);
    expect(await loadDetail(t.db, executed, [us])).toBeNull();
    expect(await loadDetail(t.db, 'not-a-uuid', null)).toBeNull();
  });
});
