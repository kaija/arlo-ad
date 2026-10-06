import { FakeChatAdapter } from '@arlo/adapters/chat';
import { FakePlatformAdapter } from '@arlo/adapters/platform';
import { createSearchTermClassifier } from '@arlo/agents';
import { say, ScriptedModel } from '@arlo/agents/testing';
import { createLogger } from '@arlo/config/logger';
import { EMPTY_BUSINESS_PROFILE, encodeAction, type ChatMessage } from '@arlo/core';
import {
  createScheduledJob,
  DEFAULT_ORG_ID,
  getBusinessProfile,
  getChangeSet,
  insertChangeSet,
  listOpResults,
  loadEntityIds,
  saveBusinessProfile,
  schema,
  setAutomationMode,
  setSlackBinding,
  startJobRun,
  upsertSearchTerms,
  upsertUserOnSignIn,
  type AdAccount,
} from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { setTracingDisabled, type ModelRequest } from '@openai/agents';
import { beforeAll, describe, expect, it } from 'vitest';
import { createExecutor } from '../../handlers/executor';
import { createInteractionHandler } from '../../handlers/interaction';
import { syncAccounts, syncSnapshots } from '../../sync/sync';
import type { TemplateContext } from '../types';
import { negativeKwSweep } from './negative-kw-sweep';

setTracingDisabled(true);
const logger = createLogger({ component: 'test', level: 'silent' });
const NOW = new Date('2026-10-07T04:00:00Z');
const ACC = '1234567890';
const CHANNEL = 'CAPPROVAL';

// What the scripted classifier says about each term.
const LABELS: Record<string, { intent: string; relevant: boolean; confidence: number }> = {
  'free camera app': { intent: 'free_or_diy', relevant: false, confidence: 0.96 }, // auto
  'camera repair course': { intent: 'free_or_diy', relevant: false, confidence: 0.95 }, // auto
  'arlo free trial': { intent: 'free_or_diy', relevant: false, confidence: 0.97 }, // brand → review
  'security camera jobs': { intent: 'jobs', relevant: false, confidence: 0.7 }, // low confidence → review
  'cheap camera': { intent: 'purchase', relevant: false, confidence: 0.95 }, // converted → review
  'outdoor camera': { intent: 'purchase', relevant: true, confidence: 0.9 }, // keep
};

describe('negative_kw_sweep', () => {
  const t = useTestDatabase();
  const platform = new FakePlatformAdapter()
    .addAccount({ externalId: ACC, name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' })
    .addEntities(ACC, [
      { kind: 'shared_set', externalId: '777', name: 'arlo-auto-negatives', status: 'ENABLED', attrs: {} },
      { kind: 'campaign', externalId: '111', name: 'Generic', status: 'ENABLED', attrs: {}, state: { budgetMicros: 1_000_000_000, bidStrategy: null, bidTarget: null } },
      { kind: 'ad_group', externalId: '221', parent: { kind: 'campaign', externalId: '111' }, name: 'Main', status: 'ENABLED', attrs: {} },
    ])
    .setClock(() => NOW);
  const chat = new FakeChatAdapter();
  const model = new ScriptedModel((req: ModelRequest) => {
    const items = req.input as { content: { text: string }[] | string }[];
    const last = items.at(-1)!.content;
    const { terms } = JSON.parse(typeof last === 'string' ? last : last[0]!.text) as { terms: { index: number; term: string }[] };
    return [say(JSON.stringify({ labels: terms.map(({ index, term }) => ({ index, ...LABELS[term]!, reason: 'scripted' })) }))];
  });
  let account: AdAccount;
  let approver: string;
  const executor = () => createExecutor({ db: t.db, platform, chat, logger, now: () => NOW, writeAllowedCustomerIds: [ACC], approvalChannel: { platform: 'slack', channelId: CHANNEL } });

  async function sweep(): Promise<string[]> {
    const job = await createScheduledJob(t.db, { name: 'sweep', template: 'negative_kw_sweep', cron: '0 3 * * *', tz: 'Asia/Taipei', accountIds: null, target: { platform: 'slack', channelId: CHANNEL }, extraInstructions: null, enabled: true });
    const run = await startJobRun(t.db, { scheduledJobId: job.id, template: 'negative_kw_sweep', trigger: 'manual' });
    const ctx: TemplateContext = {
      db: t.db,
      logger,
      now: () => NOW,
      job,
      run,
      accounts: [account],
      agents: { analyst: () => { throw new Error('unused'); }, orchestrator: () => { throw new Error('unused'); }, searchTermClassifier: () => createSearchTermClassifier({ model }) },
      propose: async (input) => ({ id: (await insertChangeSet(t.db, input)).id }),
    };
    const result = await negativeKwSweep.run(ctx);
    for (const id of result.changesetIds) await executor().process(id);
    return result.changesetIds;
  }

  beforeAll(async () => {
    const sync = { db: t.db, platform, logger, now: () => NOW };
    account = (await syncAccounts(sync))[0]!;
    await syncSnapshots(sync, account);
    const ids = await loadEntityIds(t.db, account.id, ['campaign', 'ad_group']);
    const row = (term: string, date: string, cost: number, conversions = 0) => ({
      orgId: DEFAULT_ORG_ID,
      accountId: account.id,
      campaignId: ids.get('campaign:111')!,
      adGroupId: ids.get('ad_group:221')!,
      term,
      date,
      costMicros: cost * 1_000_000,
      impressions: 100,
      clicks: 5,
      conversions,
      convValue: 0,
    });
    await upsertSearchTerms(t.db, [
      ...Object.keys(LABELS).map((term) => row(term, '2026-10-05', 50)),
      row('cheap camera', '2026-08-01', 10, 1), // converted 2 months ago
      row('old term', '2026-08-15', 30), // no spend in the last 30 days: not swept
    ]);
    await saveBusinessProfile(t.db, account.id, { ...EMPTY_BUSINESS_PROFILE, offerings: ['監視器'], brandTerms: ['arlo'] }, { kind: 'system' });
    const u = await upsertUserOnSignIn(t.db, { email: 'amy@example.com', displayName: 'Amy' });
    await setSlackBinding(t.db, u.id, 'UAMY');
    await t.db.insert(schema.roleBindings).values({ orgId: DEFAULT_ORG_ID, userId: u.id, role: 'approver', maxTier: 2 });
    approver = u.id;
    await setAutomationMode(t.db, account.id, 'negative_kw_auto', 'live', { kind: 'system' });
  });

  it('auto-excludes clear-cut terms and batches the rest for review', async () => {
    const [autoId, reviewId] = await sweep();
    expect(model.requests).toHaveLength(1);

    const auto = await getChangeSet(t.db, autoId!);
    expect(auto).toMatchObject({ status: 'EXECUTED', tier: 1, feature: 'negative_kw_auto', source: { kind: 'schedule' } });
    expect(auto!.ops.map((o) => (o.after as { text: string }).text).sort()).toEqual(['camera repair course', 'free camera app']);
    expect(platform.negativesOf(ACC, '777').map((n) => `${n.text}/${n.matchType}`).sort()).toEqual(['camera repair course/EXACT', 'free camera app/EXACT']);

    const review = await getChangeSet(t.db, reviewId!);
    expect(review).toMatchObject({ status: 'PENDING_APPROVAL', tier: 2 });
    expect(review!.ops.map((o) => [(o.after as { text: string }).text, o.meta?.reviewReason])).toEqual(
      expect.arrayContaining([
        ['arlo free trial', '含品牌字'],
        ['security camera jobs', '信心 0.70 < 0.9'],
        ['cheap camera', '近 90 天有 1 次轉換'],
      ]),
    );
    const card = chat.postedTo(CHANNEL).find((m) => m.message.type === 'approval_request' && (m.message as { changeset: { id: string } }).changeset.id === reviewId)!;
    expect((card.message as Extract<ChatMessage, { type: 'approval_request' }>).changeset.selectable).toBe(true);
  });

  it('runs only the ticked ops and records unticked terms as relevant examples', async () => {
    const reviewId = (await t.db.select().from(schema.changesets)).find((c) => c.status === 'PENDING_APPROVAL')!.id;
    const review = await getChangeSet(t.db, reviewId);
    const brandIndex = review!.ops.findIndex((o) => (o.after as { text: string }).text === 'arlo free trial');
    const handle = createInteractionHandler({ db: t.db, chat, logger, executor: executor() });
    const toggle = encodeAction({ kind: 'neg_toggle', changesetId: reviewId, opIndex: brandIndex });
    // Unticking sends the checkbox action with nothing selected.
    await handle({ type: 'block_actions', userId: 'UAMY', channelId: CHANNEL, actions: [{ actionId: toggle, selected: [] }] });
    expect((await getChangeSet(t.db, reviewId))?.excludedOps).toEqual([brandIndex]);
    const card = chat.postedTo(CHANNEL).find((m) => (m.message as { changeset?: { id: string } }).changeset?.id === reviewId)!;
    expect((card.message as Extract<ChatMessage, { type: 'approval_request' }>).changeset.ops[brandIndex]?.excluded).toBe(true);

    const result = await executor().approve(reviewId, approver);
    expect(result).toMatchObject({ outcome: 'executed' });
    expect((await listOpResults(t.db, reviewId)).map((r) => r.opIndex).sort()).toEqual([0, 1, 2].filter((i) => i !== brandIndex));
    expect(platform.negativesOf(ACC, '777').map((n) => n.text)).not.toContain('arlo free trial');
    expect((await getBusinessProfile(t.db, account.id))?.profile.examples).toEqual([{ term: 'arlo free trial', relevant: true, note: '審核時剔除，不排除' }]);
  });

  it('does not propose the same terms again', async () => {
    const requests = model.requests.length;
    expect(await sweep()).toEqual([]);
    // The profile changed (new example), so remaining terms were re-classified, but nothing new to propose.
    expect(model.requests.length).toBeGreaterThanOrEqual(requests);
  });

  it('rejects a batch with every op unticked and keeps the terms as examples', async () => {
    const ops = ['vintage camera', 'camera museum'].map((text) => ({ kind: 'google.add_negative_keyword' as const, target: { platform: 'google_ads' as const, accountId: ACC, kind: 'shared_set' as const, id: '777' }, before: null, after: { text, matchType: 'EXACT' }, meta: { minTier: 2 } }));
    const cs = await insertChangeSet(t.db, { accountId: account.id, source: { kind: 'web' }, ops, summary: 'batch', requestedBy: { kind: 'system' } });
    await executor().process(cs.id);
    const handle = createInteractionHandler({ db: t.db, chat, logger, executor: executor() });
    for (const opIndex of [0, 1]) await handle({ type: 'block_actions', userId: 'UAMY', channelId: CHANNEL, actions: [{ actionId: encodeAction({ kind: 'neg_toggle', changesetId: cs.id, opIndex }), selected: [] }] });
    expect(await executor().approve(cs.id, approver)).toMatchObject({ outcome: 'all_excluded', status: 'REJECTED' });
    expect((await getBusinessProfile(t.db, account.id))?.profile.examples.map((e) => e.term)).toEqual(expect.arrayContaining(['vintage camera', 'camera museum']));
  });
});
