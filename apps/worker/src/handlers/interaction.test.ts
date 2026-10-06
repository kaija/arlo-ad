import { FakeChatAdapter } from '@arlo/adapters/chat';
import { FakePlatformAdapter } from '@arlo/adapters/platform';
import { createLogger } from '@arlo/config/logger';
import { encodeAction, type Op, type Role } from '@arlo/core';
import { DEFAULT_ORG_ID, getChangeSet, insertChangeSet, schema, setSlackBinding, upsertUserOnSignIn, type AdAccount } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncAccounts, syncSnapshots } from '../sync/sync';
import { createExecutor } from './executor';
import { alreadyHandled, decisionJobs, DENY_TEXT, undoRefusal } from './decisions';
import { createInteractionHandler } from './interaction';

const logger = createLogger({ component: 'test', level: 'silent' });
const ACC = '1234567890';
const NOW = new Date('2026-10-07T04:00:00Z');
const CHANNEL = 'CAPPROVAL';
const CAMPAIGN = { platform: 'google_ads' as const, accountId: ACC, kind: 'campaign' as const, id: '111' };

function seededPlatform() {
  return new FakePlatformAdapter()
    .addAccount({ externalId: ACC, name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' })
    .addEntities(ACC, [
      { kind: 'campaign', externalId: '111', name: 'Brand', status: 'ENABLED', attrs: {}, state: { budgetMicros: 1_000_000_000, bidStrategy: null, bidTarget: null } },
    ])
    .setClock(() => NOW);
}

describe('Slack approve / reject interactions', () => {
  const t = useTestDatabase();
  let account: AdAccount;
  let platform: FakePlatformAdapter;
  let chat: FakeChatAdapter;
  let handle: ReturnType<typeof createInteractionHandler>;
  const users: Record<string, string> = {};

  async function user(slackId: string, grants: { role: Role; maxTier: number; accountIds?: string[] | null }[]) {
    const u = await upsertUserOnSignIn(t.db, { email: `${slackId.toLowerCase()}@example.com`, displayName: slackId });
    await setSlackBinding(t.db, u.id, slackId);
    for (const g of grants) await t.db.insert(schema.roleBindings).values({ orgId: DEFAULT_ORG_ID, userId: u.id, role: g.role, maxTier: g.maxTier, accountIds: g.accountIds ?? null });
    users[slackId] = u.id;
  }

  beforeAll(async () => {
    platform = seededPlatform();
    const sync = { db: t.db, platform, logger, now: () => NOW };
    account = (await syncAccounts(sync))[0]!;
    await syncSnapshots(sync, account);
    await user('UVIEWER', [{ role: 'viewer', maxTier: 0 }]);
    await user('UOPERATOR', [{ role: 'operator', maxTier: 0 }]);
    await user('UAPPROVER1', [{ role: 'approver', maxTier: 1 }]);
    await user('UOTHERACC', [{ role: 'approver', maxTier: 3, accountIds: ['00000000-0000-7000-8000-000000000000'] }]);
    await user('UAPPROVER', [{ role: 'approver', maxTier: 2 }]);
    await user('USENIOR', [{ role: 'approver', maxTier: 3 }]);
    await user('UADMIN', [{ role: 'admin', maxTier: 3 }]);
  });

  beforeEach(async () => {
    platform = seededPlatform();
    chat = new FakeChatAdapter();
    await t.db.delete(schema.approvalMessages);
    const deps = { db: t.db, platform, chat, logger, now: () => NOW, writeAllowedCustomerIds: [ACC], approvalChannel: { platform: 'slack' as const, channelId: CHANNEL } };
    handle = createInteractionHandler({ db: t.db, chat, logger, executor: createExecutor(deps) });
  });

  async function pending(after: number, requester?: string) {
    const ops: Op[] = [{ kind: 'set_budget', target: CAMPAIGN, field: 'budget_micros', before: 1_000_000_000, after }];
    const cs = await insertChangeSet(t.db, {
      accountId: account.id,
      source: { kind: 'web' },
      ops,
      summary: 'raise',
      requestedBy: requester ? { kind: 'user', userId: users[requester] } : { kind: 'agent' },
    });
    const deps = { db: t.db, platform, chat, logger, now: () => NOW, writeAllowedCustomerIds: [ACC], approvalChannel: { platform: 'slack' as const, channelId: CHANNEL } };
    expect(await createExecutor(deps).process(cs.id)).toMatchObject({ status: 'PENDING_APPROVAL' });
    return cs.id;
  }

  const click = (slackUser: string, verb: 'approve' | 'reject' | 'undo', changesetId: string) =>
    handle({ type: 'block_actions', userId: slackUser, channelId: CHANNEL, messageTs: '1.0', actions: [{ actionId: encodeAction({ kind: 'changeset', verb, changesetId }) }] });
  const lastEphemeral = (slackUser: string) => chat.ephemerals.filter((e) => e.userId === slackUser).at(-1)?.text;

  it.each([
    ['UVIEWER', 2, DENY_TEXT.role(2)],
    ['UOPERATOR', 2, DENY_TEXT.role(2)],
    ['UAPPROVER1', 2, DENY_TEXT.tier(2)],
    ['UOTHERACC', 2, DENY_TEXT.scope(2)],
    ['UAPPROVER', 3, DENY_TEXT.tier(3)],
  ] as const)('%s cannot approve Tier %i', async (slackUser, tier, text) => {
    const id = await pending(tier === 3 ? 2_000_000_000 : 1_100_000_000);
    await click(slackUser, 'approve', id);
    expect(lastEphemeral(slackUser)).toBe(text);
    expect((await getChangeSet(t.db, id))?.status).toBe('PENDING_APPROVAL');
  });

  it.each([['UAPPROVER'], ['UADMIN']] as const)('%s can approve Tier 2 with the button', async (slackUser) => {
    const id = await pending(1_100_000_000);
    await click(slackUser, 'approve', id);
    expect((await getChangeSet(t.db, id))?.status).toBe('EXECUTED');
    expect(lastEphemeral(slackUser)).toBeUndefined();
  });

  const submit = (slackUser: string, changesetId: string, metadata: Record<string, unknown> = { changesetId, channelId: CHANNEL }) =>
    handle({
      type: 'view_submission',
      userId: slackUser,
      actions: [],
      view: { callbackId: encodeAction({ kind: 'changeset', verb: 'confirm', changesetId }), privateMetadata: JSON.stringify(metadata), values: {} },
    });

  it('approves Tier 3 only through the confirm modal', async () => {
    const id = await pending(2_000_000_000);
    await click('USENIOR', 'approve', id);
    expect((await getChangeSet(t.db, id))?.status).toBe('PENDING_APPROVAL');
    expect(lastEphemeral('USENIOR')).toBeUndefined();

    await submit('USENIOR', id, { changesetId: 'someone-else' });
    expect((await getChangeSet(t.db, id))?.status).toBe('PENDING_APPROVAL');
    await submit('USENIOR', id);
    expect((await getChangeSet(t.db, id))?.status).toBe('EXECUTED');
  });

  it('enforces four-eyes on Tier 3, also on submit', async () => {
    const id = await pending(2_000_000_000, 'USENIOR');
    await click('USENIOR', 'approve', id);
    expect(lastEphemeral('USENIOR')).toBe(DENY_TEXT.four_eyes(3));
    await submit('USENIOR', id);
    expect(chat.ephemerals.filter((e) => e.userId === 'USENIOR')).toHaveLength(2);
    expect((await getChangeSet(t.db, id))?.status).toBe('PENDING_APPROVAL');
    await submit('UADMIN', id);
    expect((await getChangeSet(t.db, id))?.status).toBe('EXECUTED');
  });

  it('answers a repeated click with who handled it', async () => {
    const id = await pending(1_100_000_000);
    await click('UAPPROVER', 'approve', id);
    await click('UADMIN', 'approve', id);
    await click('UADMIN', 'reject', id);
    expect(chat.ephemerals.filter((e) => e.userId === 'UADMIN').map((e) => e.text)).toEqual([alreadyHandled('EXECUTED', 'UAPPROVER'), alreadyHandled('EXECUTED', 'UAPPROVER')]);
    expect(platform.applied).toHaveLength(1);
  });

  it('undoes a Tier 1 change from the notice button for operators only', async () => {
    const id = await pending(1_100_000_000);
    await click('UADMIN', 'approve', id);
    await click('UVIEWER', 'undo', id);
    expect(lastEphemeral('UVIEWER')).toBe(undoRefusal({ ok: false, reason: 'forbidden' }));
    await click('UOPERATOR', 'undo', id);
    expect((await getChangeSet(t.db, id))?.status).toBe('REVERTED');
    expect(platform.entity(CAMPAIGN)?.state?.budgetMicros).toBe(1_000_000_000);
  });

  it('runs Web decisions through the same checks (changeset.decide)', async () => {
    const deps = { db: t.db, platform, chat, logger, now: () => NOW, writeAllowedCustomerIds: [ACC], approvalChannel: { platform: 'slack' as const, channelId: CHANNEL } };
    const [job] = decisionJobs({ db: t.db, logger, executor: createExecutor(deps) });
    const run = (userId: string, verb: 'approve' | 'confirm' | 'reject' | 'undo', changesetId: string) =>
      job!.handler({ changesetId, userId, verb, reason: null }, { id: 'j', retryCount: 0, logger, signal: new AbortController().signal });

    const tier3 = await pending(2_000_000_000);
    expect(await run(users.UAPPROVER!, 'confirm', tier3)).toEqual({ outcome: 'denied' });
    expect(await run(users.USENIOR!, 'approve', tier3)).toEqual({ outcome: 'needs_confirm' });
    expect(await run(users.USENIOR!, 'confirm', tier3)).toEqual({ outcome: 'executed' });
    expect(await run(users.UOPERATOR!, 'undo', tier3)).toEqual({ outcome: 'reverted' });
    expect((await getChangeSet(t.db, tier3))?.status).toBe('REVERTED');
  });

  it('records shadow votes, one per user, and shows the totals on the card', async () => {
    const cs = await insertChangeSet(t.db, {
      accountId: account.id,
      feature: 'circuit_breaker',
      source: { kind: 'monitor' },
      ops: [{ kind: 'set_budget', target: CAMPAIGN, field: 'budget_micros', before: 1_000_000_000, after: 900_000_000 }],
      summary: '熔斷：降預算',
      requestedBy: { kind: 'system' },
    });
    const deps = { db: t.db, platform, chat, logger, now: () => NOW, writeAllowedCustomerIds: [ACC], approvalChannel: { platform: 'slack' as const, channelId: CHANNEL } };
    expect(await createExecutor(deps).process(cs.id)).toMatchObject({ status: 'SIMULATED' });
    const vote = (slackUser: string, verdict: 'up' | 'down', id = cs.id) =>
      handle({ type: 'block_actions', userId: slackUser, channelId: CHANNEL, actions: [{ actionId: encodeAction({ kind: 'shadow', verdict, changesetId: id }) }] });

    await vote('UVIEWER', 'up');
    await vote('UOPERATOR', 'down');
    await vote('UOPERATOR', 'up');
    const card = chat.postedTo(CHANNEL).find((m) => m.message.type === 'shadow_result')!;
    expect(card.message).toMatchObject({ type: 'shadow_result', feedback: { up: 2, down: 0 } });

    await vote('UOTHERACC', 'down');
    expect(lastEphemeral('UOTHERACC')).toBe('你沒有這個廣告帳戶的權限。');
    const pendingId = await pending(1_100_000_000);
    await vote('UVIEWER', 'down', pendingId);
    expect(lastEphemeral('UVIEWER')).toBe('這不是 shadow 模式的變更。');
  });

  it('rejects', async () => {
    const id = await pending(1_100_000_000);
    await click('UAPPROVER', 'reject', id);
    expect(await getChangeSet(t.db, id)).toMatchObject({ status: 'REJECTED' });
  });

  it('tells unbound Slack users to sign in and ignores unknown actions', async () => {
    const id = await pending(1_100_000_000);
    await click('UNOBODY', 'approve', id);
    expect(lastEphemeral('UNOBODY')).toContain('尚未對應');
    await handle({ type: 'block_actions', userId: 'UADMIN', channelId: CHANNEL, actions: [{ actionId: 'cs:approve:not;valid' }] });
    expect(lastEphemeral('UADMIN')).toBeUndefined();
  });
});
