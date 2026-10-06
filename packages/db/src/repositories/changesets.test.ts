import { IllegalTransitionError, type Op } from '@arlo/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ORG_ID, rules, tierThresholds } from '../schema';
import { useTestDatabase } from '../testing';
import {
  addApprovalMessage,
  applyTransition,
  countExecutedOpsSince,
  findChangeSetByMessage,
  getChangeSet,
  insertChangeSet,
  listApprovalMessages,
  listAudit,
  listChangeSets,
  listExpiredPending,
  loadRules,
  loadTierThresholds,
  recordOpResults,
} from './changesets';
import { upsertUserOnSignIn } from './identity';
import { upsertAdAccounts, upsertEntities } from './platform';

const orgId = DEFAULT_ORG_ID;
const op: Op = {
  kind: 'set_budget',
  target: { platform: 'google_ads', accountId: '1234567890', kind: 'campaign', id: '111' },
  field: 'budget_micros',
  before: 1_000_000_000,
  after: 800_000_000,
};

async function sqlState(p: PromiseLike<unknown>) {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

describe('changeset repository', () => {
  const t = useTestDatabase();
  let accountId: string;
  let otherAccountId: string;
  let campaignEntityId: string;

  beforeAll(async () => {
    const accounts = await upsertAdAccounts(t.db, [
      { orgId, platform: 'google_ads', externalId: '1234567890', name: 'TW', currency: 'TWD', timezone: 'Asia/Taipei' },
      { orgId, platform: 'google_ads', externalId: '2234567890', name: 'US', currency: 'USD', timezone: 'UTC' },
    ]);
    accountId = accounts.find((a) => a.externalId === '1234567890')!.id;
    otherAccountId = accounts.find((a) => a.externalId === '2234567890')!.id;
    campaignEntityId = (await upsertEntities(t.db, [{ orgId, accountId, kind: 'campaign', externalId: '111' }]))[0]!.id;
  });

  const create = (extra: Partial<Parameters<typeof insertChangeSet>[1]> = {}) =>
    insertChangeSet(t.db, { accountId, source: { kind: 'chat', ref: { platform: 'slack', channelId: 'C1', threadId: '1.0' } }, ops: [op], summary: '降預算', requestedBy: { kind: 'agent' }, ...extra });
  const system = { kind: 'system' as const };

  it('creates in PENDING_VALIDATION with an audit entry', async () => {
    const cs = await create();
    expect(cs).toMatchObject({ status: 'PENDING_VALIDATION', tier: null, ops: [op], source: { kind: 'chat' }, violations: [] });
    expect((await listAudit(t.db, 'changeset', cs.id)).map((a) => [a.action, a.fromStatus, a.toStatus])).toEqual([['create', null, 'PENDING_VALIDATION']]);
    await expect(create({ ops: [] })).rejects.toThrow('at least one op');
  });

  it('applies transitions with CAS and audits each one', async () => {
    const cs = await create();
    const expiresAt = new Date('2026-10-07T00:00:00Z');
    const pending = await applyTransition(t.db, cs, { type: 'request_approval', tier: 2, expiresAt }, system);
    expect(pending).toMatchObject({ ok: true, changeset: { status: 'PENDING_APPROVAL', tier: 2, expiresAt } });
    const rejected = await applyTransition(t.db, pending.ok ? pending.changeset : cs, { type: 'reject', by: 'u1' }, { kind: 'user', id: 'u1' }, { reason: '時機不對' });
    expect(rejected).toMatchObject({ ok: true, changeset: { status: 'REJECTED', statusReason: '時機不對' } });
    expect((await listAudit(t.db, 'changeset', cs.id)).map((a) => [a.action, a.toStatus, a.actorKind, a.actorId])).toEqual([
      ['create', 'PENDING_VALIDATION', 'agent', null],
      ['request_approval', 'PENDING_APPROVAL', 'system', null],
      ['reject', 'REJECTED', 'user', 'u1'],
    ]);
  });

  it('lets exactly one of many concurrent approvals win (Requirement 6.6)', async () => {
    const cs = await create();
    const pending = await applyTransition(t.db, cs, { type: 'request_approval', tier: 2, expiresAt: new Date(Date.now() + 3600_000) }, system);
    if (!pending.ok) throw new Error('setup failed');
    const approvers = await Promise.all(Array.from({ length: 8 }, (_, i) => upsertUserOnSignIn(t.db, { email: `approver${i}@example.com` })));
    const results = await Promise.all(
      approvers.map((u) => applyTransition(t.db, pending.changeset, { type: 'approve', by: u.id }, { kind: 'user', id: u.id })),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(r).toMatchObject({ ok: false, current: { status: 'APPROVED' } });
    expect((await listAudit(t.db, 'changeset', cs.id)).filter((a) => a.action === 'approve')).toHaveLength(1);
  });

  it('refuses illegal transitions before touching the database', async () => {
    const cs = await create();
    await expect(applyTransition(t.db, cs, { type: 'approve', by: 'u' }, system)).rejects.toThrow(IllegalTransitionError);
    expect((await getChangeSet(t.db, cs.id))?.status).toBe('PENDING_VALIDATION');
  });

  it('keeps audit_log append-only, even for the table owner (Requirement 3.6)', async () => {
    const cs = await create();
    expect(await sqlState(t.pool.query(`update audit_log set action = 'x' where entity_id = $1`, [cs.id]))).toBe('42501');
    expect(await sqlState(t.pool.query(`delete from audit_log where entity_id = $1`, [cs.id]))).toBe('42501');
    expect(await sqlState(t.pool.query(`truncate audit_log`))).toBe('42501');
    expect(await listAudit(t.db, 'changeset', cs.id)).toHaveLength(1);
  });

  it('records op results, approval messages and lists by filter', async () => {
    const cs = await create();
    await recordOpResults(t.db, cs.id, [{ index: 0, ok: true, resourceName: 'customers/1234567890/campaigns/111' }]);
    expect(await countExecutedOpsSince(t.db, accountId, new Date(Date.now() - 60_000))).toBeGreaterThanOrEqual(1);
    expect(await countExecutedOpsSince(t.db, otherAccountId, new Date(0))).toBe(0);

    await addApprovalMessage(t.db, { changesetId: cs.id, channelId: 'C1', messageId: '1.5', threadId: '1.0', kind: 'origin' });
    await addApprovalMessage(t.db, { changesetId: cs.id, channelId: 'CAPPROVE', messageId: '2.0', kind: 'mirror' });
    await addApprovalMessage(t.db, { changesetId: cs.id, channelId: 'C1', messageId: '1.5', kind: 'origin' });
    expect((await listApprovalMessages(t.db, cs.id)).map((m) => m.kind)).toEqual(['origin', 'mirror']);
    expect(await findChangeSetByMessage(t.db, 'CAPPROVE', '2.0')).toBe(cs.id);

    expect((await listChangeSets(t.db, { statuses: ['REJECTED'] })).every((c) => c.status === 'REJECTED')).toBe(true);
    expect(await listChangeSets(t.db, { accountIds: [] })).toEqual([]);
    expect((await listChangeSets(t.db, { accountIds: [accountId], limit: 2 })).length).toBe(2);
  });

  it('finds pending ChangeSets past their expiry', async () => {
    const cs = await create();
    await applyTransition(t.db, cs, { type: 'request_approval', tier: 2, expiresAt: new Date('2020-01-01T00:00:00Z') }, system);
    expect((await listExpiredPending(t.db, new Date())).map((c) => c.id)).toContain(cs.id);
  });

  describe('rules and thresholds', () => {
    it('loads org and account rules for an account, validating specs and scope', async () => {
      await t.db.insert(rules).values([
        { orgId, scopeKind: 'org', spec: { type: 'MaxMutationsPerDay', n: 50 }, severity: 'HARD_BLOCK' },
        { orgId, scopeKind: 'account', accountId, spec: { type: 'DailyBudgetCap', maxMicros: 5_000_000_000 }, severity: 'HARD_BLOCK' },
        { orgId, scopeKind: 'campaign', accountId, campaignEntityId, spec: { type: 'DailyBudgetCap', maxMicros: 9_000_000_000 }, severity: 'WARN' },
        { orgId, scopeKind: 'account', accountId: otherAccountId, spec: { type: 'DailyBudgetCap', maxMicros: 1 }, severity: 'HARD_BLOCK' },
      ]);
      const loaded = await loadRules(t.db, accountId);
      expect(loaded.map((r) => [r.scope.kind, r.spec.type, r.severity]).sort()).toEqual([
        ['account', 'DailyBudgetCap', 'HARD_BLOCK'],
        ['campaign', 'DailyBudgetCap', 'WARN'],
        ['org', 'MaxMutationsPerDay', 'HARD_BLOCK'],
      ]);
      // An org rule must not carry an account, a campaign rule must name both.
      expect(await sqlState(t.db.insert(rules).values({ orgId, scopeKind: 'org', accountId, spec: {}, severity: 'WARN' }))).toBe('23514');
      expect(await sqlState(t.db.insert(rules).values({ orgId, scopeKind: 'campaign', accountId, spec: {}, severity: 'WARN' }))).toBe('23514');
    });

    it('uses account thresholds over the org default over the built-in default', async () => {
      expect(await loadTierThresholds(t.db, accountId)).toEqual({ tier3Pct: 0.5, tier3AmountMicros: null, tier1MaxReducePct: 0.3 });
      await t.db.insert(tierThresholds).values({ orgId, tier3Pct: 0.4, tier3AmountMicros: 10_000_000_000, tier1MaxReducePct: 0.2 });
      await t.db.insert(tierThresholds).values({ orgId, accountId, tier3Pct: 0.25, tier1MaxReducePct: 0.1 });
      expect(await loadTierThresholds(t.db, accountId)).toEqual({ tier3Pct: 0.25, tier3AmountMicros: null, tier1MaxReducePct: 0.1 });
      expect(await loadTierThresholds(t.db, otherAccountId)).toEqual({ tier3Pct: 0.4, tier3AmountMicros: 10_000_000_000, tier1MaxReducePct: 0.2 });
      // One org default only.
      expect(await sqlState(t.db.insert(tierThresholds).values({ orgId, tier3Pct: 0.9, tier1MaxReducePct: 0.1 }))).toBe('23505');
    });
  });
});
