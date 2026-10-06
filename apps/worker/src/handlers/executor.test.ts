import { FakeChatAdapter } from '@arlo/adapters/chat';
import { FakePlatformAdapter } from '@arlo/adapters/platform';
import { createLogger } from '@arlo/config/logger';
import type { ChangeSetSource, EntityKind, Op } from '@arlo/core';
import { DEFAULT_ORG_ID, getChangeSet, insertChangeSet, listApprovalMessages, listAudit, listOpResults, schema, upsertUserOnSignIn, type AdAccount } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncAccounts, syncSnapshots } from '../sync/sync';
import { createExecutor, type ExecutorDeps } from './executor';

const logger = createLogger({ component: 'test', level: 'silent' });
const ACC = '1234567890';
const NOW = new Date('2026-10-07T04:00:00Z');
const APPROVAL = { platform: 'slack' as const, channelId: 'CAPPROVAL' };
const THREAD = { platform: 'slack' as const, channelId: 'CTEAM', threadId: '1700000000.000100' };

const ref = (kind: EntityKind, id: string) => ({ platform: 'google_ads' as const, accountId: ACC, kind, id });
const CAMPAIGN = ref('campaign', '111');
const KEYWORD = ref('keyword', '221~3001');

function seededPlatform() {
  return new FakePlatformAdapter()
    .addAccount({ externalId: ACC, name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' })
    .addEntities(ACC, [
      { kind: 'campaign', externalId: '111', name: 'Brand', status: 'ENABLED', attrs: {}, state: { budgetMicros: 1_000_000_000, bidStrategy: 'TARGET_CPA', bidTarget: 200_000_000 } },
      { kind: 'ad_group', externalId: '221', parent: { kind: 'campaign', externalId: '111' }, name: 'Brand AG', status: 'ENABLED', attrs: {} },
      { kind: 'keyword', externalId: '221~3001', parent: { kind: 'ad_group', externalId: '221' }, name: 'arlo', status: 'ENABLED', attrs: { matchType: 'EXACT' } },
    ])
    .setClock(() => NOW);
}

describe('Executor.process', () => {
  const t = useTestDatabase();
  let platform: FakePlatformAdapter;
  let chat: FakeChatAdapter;
  let account: AdAccount;
  let deps: ExecutorDeps;

  beforeAll(async () => {
    platform = seededPlatform();
    const sync = { db: t.db, platform, logger, now: () => NOW };
    account = (await syncAccounts(sync))[0]!;
    await syncSnapshots(sync, account);
  });

  beforeEach(async () => {
    platform = seededPlatform();
    chat = new FakeChatAdapter();
    deps = { db: t.db, platform, chat, logger, now: () => NOW, writeAllowedCustomerIds: [ACC], approvalChannel: APPROVAL };
    await t.db.delete(schema.rules);
    // Each FakeChatAdapter restarts its message ids; clear cards so they do not collide.
    await t.db.delete(schema.approvalMessages);
  });

  const budget = (after: number, before = 1_000_000_000): Op => ({ kind: 'set_budget', target: CAMPAIGN, field: 'budget_micros', before, after });
  const pauseKeyword: Op = { kind: 'set_status', target: KEYWORD, field: 'status', before: 'ENABLED', after: 'PAUSED' };
  const propose = (ops: Op[], source: ChangeSetSource = { kind: 'chat', ref: THREAD }) =>
    insertChangeSet(t.db, { accountId: account.id, source, ops, summary: 'test change', requestedBy: { kind: 'agent' } });

  it('requests approval for Tier 2 in the source thread and records the card', async () => {
    const cs = await propose([budget(1_100_000_000)]);
    const done = await createExecutor(deps).process(cs.id);

    expect(done).toMatchObject({ status: 'PENDING_APPROVAL', tier: 2, expiresAt: new Date(NOW.getTime() + 24 * 3_600_000) });
    const [card] = chat.postedTo(THREAD.channelId, THREAD.threadId);
    expect(card?.message).toMatchObject({
      type: 'approval_request',
      changeset: { id: cs.id, accountName: 'Arlo TW', tier: 2, status: 'PENDING_APPROVAL', requestedBy: 'Arlo', ops: [{ label: 'Brand · 每日預算', before: 'NT$1,000', after: 'NT$1,100' }] },
    });
    expect(await listApprovalMessages(t.db, cs.id)).toMatchObject([{ channelId: 'CTEAM', messageId: card!.ref.messageId, kind: 'origin' }]);
    expect(platform.applied).toEqual([]);
    expect((await listAudit(t.db, 'changeset', cs.id)).map((a) => a.action)).toEqual(['create', 'request_approval']);
  });

  it('is idempotent on retry', async () => {
    const cs = await propose([budget(1_100_000_000)]);
    const executor = createExecutor(deps);
    await executor.process(cs.id);
    await executor.process(cs.id);
    expect(chat.messages).toHaveLength(1);
  });

  it('posts a missing approval card on retry', async () => {
    const cs = await propose([budget(1_100_000_000)]);
    const failing = { ...deps, chat: { ...chat, post: async () => Promise.reject(new Error('slack down')) } as unknown as FakeChatAdapter };
    expect(await createExecutor(failing).process(cs.id)).toMatchObject({ status: 'PENDING_APPROVAL' });
    expect(chat.messages).toHaveLength(0);
    await createExecutor(deps).process(cs.id);
    expect(chat.messages).toHaveLength(1);
  });

  it('sends ChangeSets without a conversation to the approval channel with a shorter TTL for the circuit breaker', async () => {
    const cs = await insertChangeSet(t.db, {
      accountId: account.id,
      feature: 'circuit_breaker',
      source: { kind: 'monitor', monitorRuleId: 'r1' },
      ops: [budget(1_100_000_000)],
      summary: 'monitor',
      requestedBy: { kind: 'system' },
    });
    const done = await createExecutor(deps).process(cs.id);
    expect(done?.expiresAt).toEqual(new Date(NOW.getTime() + 4 * 3_600_000));
    expect(chat.postedTo(APPROVAL.channelId)).toHaveLength(1);
  });

  it('blocks on a hard-block rule and tells the source', async () => {
    await t.db.insert(schema.rules).values({ orgId: DEFAULT_ORG_ID, scopeKind: 'org', spec: { type: 'DailyBudgetCap', maxMicros: 1_050_000_000 }, severity: 'HARD_BLOCK' });
    const cs = await propose([budget(1_100_000_000)]);
    const done = await createExecutor(deps).process(cs.id);

    expect(done).toMatchObject({ status: 'BLOCKED', violations: [{ ruleType: 'DailyBudgetCap', severity: 'HARD_BLOCK' }] });
    expect(chat.postedTo(THREAD.channelId)[0]?.message).toMatchObject({ type: 'notice', level: 'error', text: expect.stringContaining('超過上限') });
    expect(platform.applied).toEqual([]);
  });

  it('raises a protective change to Tier 2 when the validator warns', async () => {
    await t.db.insert(schema.rules).values({ orgId: DEFAULT_ORG_ID, scopeKind: 'org', spec: { type: 'MaxChangePct', pct: 0.05, windowHours: 24 }, severity: 'WARN' });
    const cs = await propose([budget(900_000_000)]);
    expect(await createExecutor(deps).process(cs.id)).toMatchObject({ status: 'PENDING_APPROVAL', tier: 2 });
  });

  it('auto-executes Tier 1 and posts a notice with Undo', async () => {
    const cs = await propose([budget(900_000_000), pauseKeyword]);
    const done = await createExecutor(deps).process(cs.id);

    expect(done).toMatchObject({ status: 'EXECUTED', tier: 1, executedAt: NOW });
    expect(platform.entity(CAMPAIGN)?.state?.budgetMicros).toBe(900_000_000);
    expect(platform.entity(KEYWORD)?.status).toBe('PAUSED');
    expect((await listOpResults(t.db, cs.id)).map((r) => r.ok)).toEqual([true, true]);
    expect(chat.postedTo(THREAD.channelId)[0]?.message).toMatchObject({ type: 'notice', level: 'info', changesetId: cs.id, actions: ['undo'], text: expect.stringContaining('NT$1,000 → NT$900') });
    expect((await listAudit(t.db, 'changeset', cs.id)).map((a) => a.toStatus)).toEqual(['PENDING_VALIDATION', 'EXECUTING', 'EXECUTED']);
  });

  it('marks Tier 1 STALE when the account changed since the proposal', async () => {
    platform.drift(CAMPAIGN, { budgetMicros: 1_200_000_000 });
    const cs = await propose([budget(900_000_000)]);
    const done = await createExecutor(deps).process(cs.id);

    expect(done).toMatchObject({ status: 'STALE', statusReason: expect.stringContaining('1200000000') });
    expect(platform.applied).toEqual([]);
    expect(chat.postedTo(THREAD.channelId)[0]?.message).toMatchObject({ type: 'notice', level: 'warn' });
  });

  it('records partial failure per op and marks FAILED', async () => {
    platform.failOps((op) => (op.kind === 'set_status' ? 'RESOURCE_NOT_FOUND' : undefined));
    const cs = await propose([budget(900_000_000), pauseKeyword]);
    const done = await createExecutor(deps).process(cs.id);

    expect(done).toMatchObject({ status: 'FAILED', statusReason: expect.stringContaining('1/2') });
    expect((await listOpResults(t.db, cs.id)).map((r) => [r.ok, r.error])).toEqual([
      [true, null],
      [false, 'RESOURCE_NOT_FOUND'],
    ]);
    expect(chat.postedTo(THREAD.channelId)[0]?.message).toMatchObject({ type: 'notice', level: 'error' });
  });

  it('refuses to write to accounts outside the allowlist', async () => {
    const cs = await propose([budget(900_000_000)]);
    const done = await createExecutor({ ...deps, writeAllowedCustomerIds: [] }).process(cs.id);

    expect(done).toMatchObject({ status: 'FAILED', statusReason: expect.stringContaining('WRITE_NOT_ALLOWED') });
    expect(platform.applied).toEqual([]);
  });
});

describe('Executor.approve / reject', () => {
  const t = useTestDatabase();
  let platform: FakePlatformAdapter;
  let chat: FakeChatAdapter;
  let account: AdAccount;
  let deps: ExecutorDeps;
  let ann: string;
  let bob: string;

  beforeAll(async () => {
    platform = seededPlatform();
    const sync = { db: t.db, platform, logger, now: () => NOW };
    account = (await syncAccounts(sync))[0]!;
    await syncSnapshots(sync, account);
    ann = (await upsertUserOnSignIn(t.db, { email: 'ann@example.com', displayName: 'Ann' })).id;
    bob = (await upsertUserOnSignIn(t.db, { email: 'bob@example.com', displayName: 'Bob' })).id;
  });

  beforeEach(async () => {
    platform = seededPlatform();
    chat = new FakeChatAdapter();
    deps = { db: t.db, platform, chat, logger, now: () => NOW, writeAllowedCustomerIds: [ACC], approvalChannel: APPROVAL };
    await t.db.delete(schema.rules);
    await t.db.delete(schema.approvalMessages);
  });

  const raise: Op = { kind: 'set_budget', target: CAMPAIGN, field: 'budget_micros', before: 1_000_000_000, after: 1_100_000_000 };
  const enableKeyword: Op = { kind: 'set_status', target: KEYWORD, field: 'status', before: 'ENABLED', after: 'PAUSED' };

  async function pending(ops: Op[] = [raise]) {
    const cs = await insertChangeSet(t.db, { accountId: account.id, source: { kind: 'chat', ref: THREAD }, ops, summary: 'raise Brand', requestedBy: { kind: 'user', userId: ann } });
    const executor = createExecutor(deps);
    expect(await executor.process(cs.id)).toMatchObject({ status: 'PENDING_APPROVAL' });
    return { cs, executor, card: chat.postedTo(THREAD.channelId)[0]! };
  }

  it('executes after approval and updates the card with the approver', async () => {
    const { cs, executor, card } = await pending();
    const result = await executor.approve(cs.id, bob);

    expect(result).toMatchObject({ outcome: 'executed', status: 'EXECUTED' });
    expect(platform.entity(CAMPAIGN)?.state?.budgetMicros).toBe(1_100_000_000);
    expect(card.message).toMatchObject({ type: 'approval_request', changeset: { status: 'EXECUTED', requestedBy: 'Ann', outcome: { status: 'EXECUTED', actor: 'Bob' } } });
    expect((await getChangeSet(t.db, cs.id))?.approvedBy).toBe(bob);
    const audit = await listAudit(t.db, 'changeset', cs.id);
    expect(audit.map((a) => [a.action, a.actorKind])).toEqual([
      ['create', 'user'],
      ['request_approval', 'system'],
      ['approve', 'user'],
      ['execute', 'user'],
      ['executed', 'user'],
    ]);
  });

  it('handles a double click once and reports who handled it', async () => {
    const { cs, executor } = await pending();
    const [first, second] = await Promise.all([executor.approve(cs.id, bob), executor.approve(cs.id, ann)]);
    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['executed', 'not_pending']);
    expect(platform.applied).toHaveLength(1);
    const late = await executor.approve(cs.id, ann);
    expect(late).toMatchObject({ outcome: 'not_pending', status: 'EXECUTED', handledBy: 'Bob' });
  });

  it('marks STALE when the target drifted since the proposal', async () => {
    const { cs, executor, card } = await pending();
    platform.drift(CAMPAIGN, { budgetMicros: 1_300_000_000 });
    const result = await executor.approve(cs.id, bob);

    expect(result).toMatchObject({ outcome: 'stale', status: 'STALE' });
    expect(platform.applied).toEqual([]);
    expect(card.message).toMatchObject({ changeset: { outcome: { status: 'STALE', actor: 'Bob' } } });
    expect(chat.postedTo(THREAD.channelId).at(-1)?.message).toMatchObject({ type: 'notice', level: 'warn', text: expect.stringContaining('重新提議') });
  });

  it('blocks when re-validation with fresh context fails', async () => {
    const { cs, executor } = await pending();
    await t.db.insert(schema.rules).values({ orgId: DEFAULT_ORG_ID, scopeKind: 'org', spec: { type: 'DailyBudgetCap', maxMicros: 1_050_000_000 }, severity: 'HARD_BLOCK' });
    const result = await executor.approve(cs.id, bob);

    expect(result).toMatchObject({ outcome: 'blocked', status: 'BLOCKED', changeset: { violations: [{ ruleType: 'DailyBudgetCap' }] } });
    expect(platform.applied).toEqual([]);
  });

  it('marks FAILED on partial failure and keeps the successful op results', async () => {
    const { cs, executor } = await pending([raise, enableKeyword]);
    platform.failOps((op) => (op.kind === 'set_status' ? 'INTERNAL_ERROR' : undefined));
    const result = await executor.approve(cs.id, bob);

    expect(result).toMatchObject({ outcome: 'failed', status: 'FAILED' });
    expect((await listOpResults(t.db, cs.id)).map((r) => r.ok)).toEqual([true, false]);
    expect(platform.entity(CAMPAIGN)?.state?.budgetMicros).toBe(1_100_000_000);
  });

  it('expires instead of executing past expires_at', async () => {
    const { cs } = await pending();
    const later = createExecutor({ ...deps, now: () => new Date(NOW.getTime() + 25 * 3_600_000) });
    expect(await later.approve(cs.id, bob)).toMatchObject({ outcome: 'expired', status: 'EXPIRED' });
    expect(platform.applied).toEqual([]);
  });

  it('rejects with a reason, once', async () => {
    const { cs, executor, card } = await pending();
    const result = await executor.reject(cs.id, bob, '  not now ');

    expect(result).toMatchObject({ ok: true, changeset: { status: 'REJECTED', statusReason: 'not now' } });
    expect(card.message).toMatchObject({ changeset: { outcome: { status: 'REJECTED', actor: 'Bob', reason: 'not now' } } });
    expect(await executor.reject(cs.id, ann)).toMatchObject({ ok: false, status: 'REJECTED', handledBy: 'Bob' });
    expect(await executor.approve(cs.id, ann)).toMatchObject({ outcome: 'not_pending', status: 'REJECTED', handledBy: 'Bob' });
  });
});
