import { DEFAULT_ORG_ID, getChangeSet, insertChangeSet, insertEntitySnapshots, schema, upsertAdAccounts, upsertEntities, upsertUserOnSignIn, type NewChangeSet } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBiddingAgent } from '../agents/bidding';
import { createOrchestrator } from '../agents/orchestrator';
import { createAnalystAgent } from '../agents/analyst';
import type { AgentContext } from '../context';
import { runGetChangeSetStatus, runProposeBidTarget, runProposeBudget, runProposeStatus } from './propose';
import { ToolInputError } from './read';

const orgId = DEFAULT_ORG_ID;
const M = 1_000_000;
const now = () => new Date('2026-10-07T04:00:00Z');
const THREAD = { platform: 'slack' as const, channelId: 'CTEAM', threadId: '1.2' };

describe('propose tools', () => {
  const t = useTestDatabase();
  let tw: string;
  let operator: string;
  let viewer: string;
  const proposals: NewChangeSet[] = [];

  const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
    db: t.db,
    allowedAccountIds: null,
    now,
    user: { id: operator },
    source: { kind: 'chat', ref: THREAD },
    traceId: 'trace_1',
    propose: async (input) => {
      proposals.push(input);
      return { id: (await insertChangeSet(t.db, input)).id };
    },
    ...over,
  });

  beforeAll(async () => {
    const [account] = await upsertAdAccounts(t.db, [{ orgId, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    tw = account!.id;
    const campaigns = await upsertEntities(t.db, [
      { orgId, accountId: tw, kind: 'campaign', externalId: '111', name: 'Brand', status: 'ENABLED', attrs: { budgetShared: false } },
      { orgId, accountId: tw, kind: 'campaign', externalId: '112', name: 'Generic', status: 'PAUSED', attrs: { budgetShared: false } },
      { orgId, accountId: tw, kind: 'campaign', externalId: '113', name: 'Shared', status: 'ENABLED', attrs: { budgetShared: true } },
    ]);
    const id = (ext: string) => campaigns.find((c) => c.externalId === ext)!.id;
    await upsertEntities(t.db, [{ orgId, accountId: tw, kind: 'keyword', externalId: '221~3001', name: 'arlo', status: 'ENABLED' }]);
    await insertEntitySnapshots(t.db, [
      { orgId, entityId: id('111'), capturedAt: new Date('2026-10-07T03:30:00Z'), budgetMicros: 800 * M, status: 'ENABLED', bidStrategy: 'TARGET_CPA', bidTarget: 250 * M },
      { orgId, entityId: id('111'), capturedAt: new Date('2026-10-07T03:45:00Z'), budgetMicros: 900 * M, status: 'ENABLED', bidStrategy: 'TARGET_CPA', bidTarget: 250 * M },
      { orgId, entityId: id('112'), capturedAt: new Date('2026-10-07T03:45:00Z'), budgetMicros: 500 * M, status: 'PAUSED', bidStrategy: 'TARGET_ROAS', bidTarget: 4.5 },
      { orgId, entityId: id('113'), capturedAt: new Date('2026-10-07T03:45:00Z'), budgetMicros: 300 * M, status: 'ENABLED', bidStrategy: null, bidTarget: null },
    ]);
    operator = (await upsertUserOnSignIn(t.db, { email: 'op@example.com' })).id;
    viewer = (await upsertUserOnSignIn(t.db, { email: 'viewer@example.com' })).id;
    await t.db.insert(schema.roleBindings).values([
      { orgId, userId: operator, role: 'operator', maxTier: 0 },
      { orgId, userId: viewer, role: 'viewer', maxTier: 0 },
    ]);
  });

  it('propose_budget takes before from the latest snapshot and records the source', async () => {
    const out = await runProposeBudget(ctx(), { account: 'Arlo TW', campaign: 'brand', dailyBudget: 1200, reason: 'IS lost to budget 30%' });
    const cs = await getChangeSet(t.db, out.changesetId);
    expect(cs).toMatchObject({
      status: 'PENDING_VALIDATION',
      source: { kind: 'chat', ref: THREAD },
      traceId: 'trace_1',
      rationale: 'IS lost to budget 30%',
      requestedBy: { kind: 'user', userId: operator },
      ops: [{ kind: 'set_budget', target: { platform: 'google_ads', accountId: '1234567890', kind: 'campaign', id: '111' }, field: 'budget_micros', before: 900 * M, after: 1200 * M }],
    });
    expect(out.summary).toBe('Brand 每日預算 NT$900 → NT$1,200');
  });

  it('propose_status batches targets and skips ones already in that state', async () => {
    const out = await runProposeStatus(ctx(), { account: '1234567890', level: 'campaign', ids: ['111', 'Generic'], status: 'PAUSED', reason: null });
    expect((await getChangeSet(t.db, out.changesetId))?.ops).toEqual([
      { kind: 'set_status', target: expect.objectContaining({ id: '111' }), field: 'status', before: 'ENABLED', after: 'PAUSED' },
    ]);
    const kw = await runProposeStatus(ctx(), { account: 'Arlo TW', level: 'keyword', ids: ['221~3001'], status: 'PAUSED', reason: null });
    expect((await getChangeSet(t.db, kw.changesetId))?.ops[0]).toMatchObject({ target: { kind: 'keyword', id: '221~3001' }, before: 'ENABLED' });
  });

  it('propose_bid_target picks the field from the bid strategy', async () => {
    const cpa = await runProposeBidTarget(ctx(), { account: 'Arlo TW', campaign: '111', targetCpa: 220, targetRoas: null, reason: null });
    expect((await getChangeSet(t.db, cpa.changesetId))?.ops[0]).toMatchObject({ field: 'target_cpa_micros', before: 250 * M, after: 220 * M });
    const roas = await runProposeBidTarget(ctx(), { account: 'Arlo TW', campaign: '112', targetCpa: null, targetRoas: 5, reason: null });
    expect((await getChangeSet(t.db, roas.changesetId))?.ops[0]).toMatchObject({ field: 'target_roas', before: 4.5, after: 5 });
    await expect(runProposeBidTarget(ctx(), { account: 'Arlo TW', campaign: '112', targetCpa: 100, targetRoas: null, reason: null })).rejects.toThrow('沒有目標 CPA');
  });

  it.each<[string, () => Promise<unknown>, string]>([
    ['shared budgets', () => runProposeBudget(ctx(), { account: 'Arlo TW', campaign: 'Shared', dailyBudget: 400, reason: null }), '共用預算'],
    ['unknown campaigns', () => runProposeBudget(ctx(), { account: 'Arlo TW', campaign: 'Nope', dailyBudget: 400, reason: null }), '找不到 campaign'],
    ['accounts outside scope', () => runProposeBudget(ctx({ allowedAccountIds: [] }), { account: 'Arlo TW', campaign: '111', dailyBudget: 400, reason: null }), '找不到你有權限的帳戶'],
    ['viewers', () => runProposeBudget(ctx({ user: { id: viewer } }), { account: 'Arlo TW', campaign: '111', dailyBudget: 400, reason: null }), 'operator'],
    ['runs without a proposer', () => runProposeBudget(ctx({ propose: undefined }), { account: 'Arlo TW', campaign: '111', dailyBudget: 400, reason: null }), '不允許'],
  ])('refuses %s', async (_, call, message) => {
    const before = proposals.length;
    await expect(call()).rejects.toThrow(ToolInputError);
    await expect(call()).rejects.toThrow(message);
    expect(proposals.length).toBe(before);
  });

  it('get_changeset_status reports status within the caller scope', async () => {
    const out = await runProposeBudget(ctx(), { account: 'Arlo TW', campaign: '111', dailyBudget: 950, reason: null });
    expect(await runGetChangeSetStatus(ctx(), { changesetId: out.changesetId })).toMatchObject({ status: 'PENDING_VALIDATION', ops: [{ before: 900, after: 950 }] });
    await expect(runGetChangeSetStatus(ctx({ allowedAccountIds: [] }), { changesetId: out.changesetId })).rejects.toThrow('找不到');
  });

  it('agents only get read and propose tools (no mutate capability)', () => {
    const bidding = createBiddingAgent({ model: 'test' });
    const orchestrator = createOrchestrator({ model: 'test', specialists: { analyst: createAnalystAgent({ model: 'test' }), bidding } });
    const names = (a: { tools: { name: string }[] }) => a.tools.map((x) => x.name);
    expect(names(bidding)).toEqual(['list_campaigns', 'query_metrics', 'get_pacing', 'propose_budget', 'propose_status', 'propose_bid_target', 'get_changeset_status', 'run_budget_optimizer', 'propose_budget_reallocation', 'suggest_bid_targets', 'propose_bid_target_adjustments']);
    expect(names(orchestrator)).toEqual(['analyst', 'bidding', 'get_changeset_status', 'create_campaign_task']);
    for (const name of [...names(bidding), ...names(orchestrator)]) expect(name).not.toMatch(/apply|mutate|execute|approve/i);
  });
});
