// E2E (Requirements 3.3, 6.3, 7.1; ADR-0026): a signed Slack mention reaches the web endpoint,
// the worker's Orchestrator → bidding agent proposes a budget change, the Executor routes it for
// approval, and a signed Approve click executes it. Fake platform / chat adapters, scripted model.
import { FakeChatAdapter, signSlackRequest } from '@arlo/adapters/chat';
import { FakePlatformAdapter } from '@arlo/adapters/platform';
import { createAnalystAgent, createBiddingAgent, createOrchestrator } from '@arlo/agents';
import { callTool, say, ScriptedModel, toolResultText } from '@arlo/agents/testing';
import { createLogger } from '@arlo/config/logger';
import { encodeAction, type ChatMessage } from '@arlo/core';
import { DEFAULT_ORG_ID, getChangeSet, listAudit, schema, setSlackBinding, upsertUserOnSignIn, type AdAccount } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { ALL_JOBS, createBoss, ensureQueues, Jobs, type JobDefinition, type PgBoss } from '@arlo/queue';
import { setTracingDisabled } from '@openai/agents';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as slackEvents } from '../../../web/app/api/slack/events/route';
import { POST as slackInteractivity } from '../../../web/app/api/slack/interactivity/route';
import { getBoss } from '../../../web/lib/queue';
import { getPool } from '../../../web/lib/server';
import { chatJobs } from '../handlers/chat';
import { createExecutor, executorJobs } from '../handlers/executor';
import { interactionJobs } from '../handlers/interaction';
import { createProposer } from '../proposals';
import { syncAccounts, syncSnapshots } from '../sync/sync';

setTracingDisabled(true);
const logger = createLogger({ component: 'e2e', level: 'silent' });
const SECRET = 'e2e-signing-secret';
const ACC = '1234567890';
const NOW = new Date('2026-10-07T04:00:00Z');
const TEAM = 'CTEAM';
const APPROVAL = { platform: 'slack' as const, channelId: 'CAPPROVAL' };

function signed(path: 'events' | 'interactivity', body: string, contentType: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request(`http://localhost/api/slack/${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signSlackRequest(SECRET, timestamp, body) },
    body,
  });
}

describe('E2E: Slack mention → propose → approve → EXECUTED', () => {
  const t = useTestDatabase();
  const platform = new FakePlatformAdapter()
    .addAccount({ externalId: ACC, name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' })
    .addEntities(ACC, [
      { kind: 'campaign', externalId: '111', name: 'Brand', status: 'ENABLED', attrs: { budgetShared: false }, state: { budgetMicros: 1_000_000_000, bidStrategy: 'TARGET_CPA', bidTarget: 200_000_000 } },
    ])
    .setClock(() => NOW);
  const chat = new FakeChatAdapter().addUser('UREQ', { displayName: 'Ren' });
  let boss: PgBoss;
  let account: AdAccount;
  let definitions: JobDefinition[];

  // Orchestrator hands the request to bidding; bidding proposes; both then answer in text.
  const orchestratorModel = new ScriptedModel((_req, { lastItem }) =>
    toolResultText(lastItem) ? [say('已送出 Brand 每日預算調整，等待審核。')] : [callTool('bidding', { input: 'Arlo TW 帳戶 Brand campaign 每日預算調到 NT$1,100' })],
  );
  const biddingModel = new ScriptedModel((_req, { lastItem }) =>
    toolResultText(lastItem)
      ? [say(`已建立 ChangeSet：${JSON.parse(toolResultText(lastItem)!).changesetId}`)]
      : [callTool('propose_budget', { account: 'Arlo TW', campaign: 'Brand', dailyBudget: 1100, reason: '預算受限流失曝光' })],
  );

  /** Runs every queued job of `name` through its worker handler, like pg-boss would. */
  async function drain(name: string): Promise<number> {
    const def = definitions.find((d) => d.name === name)!;
    let n = 0;
    for (;;) {
      const jobs = await boss.fetch<unknown>(name, { batchSize: 10 });
      if (jobs.length === 0) return n;
      for (const job of jobs) {
        await def.handler(def.schema.parse(job.data), { id: job.id, retryCount: 0, logger, signal: new AbortController().signal });
        await boss.complete(name, job.id);
        n++;
      }
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = t.url;
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.SLACK_BOT_TOKEN = 'xoxb-e2e';
    boss = createBoss({ connectionString: t.url, logger, role: 'migrator' });
    await boss.start();
    await ensureQueues(boss, ALL_JOBS);

    const sync = { db: t.db, platform, logger, now: () => NOW };
    account = (await syncAccounts(sync))[0]!;
    await syncSnapshots(sync, account);
    for (const [slack, email, role, maxTier] of [
      ['UREQ', 'ren@example.com', 'operator', 0],
      ['UAPP', 'amy@example.com', 'approver', 2],
    ] as const) {
      const u = await upsertUserOnSignIn(t.db, { email, displayName: slack === 'UREQ' ? 'Ren' : 'Amy' });
      await setSlackBinding(t.db, u.id, slack);
      await t.db.insert(schema.roleBindings).values({ orgId: DEFAULT_ORG_ID, userId: u.id, role, maxTier });
    }

    const executor = createExecutor({ db: t.db, platform, chat, logger, now: () => NOW, writeAllowedCustomerIds: [ACC], approvalChannel: APPROVAL });
    definitions = [
      ...chatJobs({
        db: t.db,
        chat,
        logger,
        now: () => NOW,
        orchestrator: () => createOrchestrator({ model: orchestratorModel, specialists: { analyst: createAnalystAgent({ model: orchestratorModel }), bidding: createBiddingAgent({ model: biddingModel }) } }),
        propose: createProposer(t.db, boss),
      }),
      ...executorJobs(executor),
      ...interactionJobs({ db: t.db, chat, logger, executor }),
    ];
  });

  afterAll(async () => {
    await (await getBoss()).stop({ graceful: false, close: true });
    await getPool().end();
    await boss.stop({ graceful: false, close: true });
  });

  it('runs the whole approval flow from signed Slack payloads', async () => {
    // 1. Slack mention → web endpoint (signature, de-dup, enqueue).
    const root = chat.say(TEAM, 'UREQ', '<@UBOT> 把 Brand 每日預算調到 1100');
    const event = JSON.stringify({
      type: 'event_callback',
      event_id: 'EvE2E1',
      team_id: 'T1',
      event: { type: 'app_mention', user: 'UREQ', text: '<@UBOT> 把 Brand 每日預算調到 1100', ts: root, channel: TEAM },
    });
    expect((await slackEvents(signed('events', event, 'application/json'))).status).toBe(200);

    // 2. Worker: Orchestrator → bidding → propose_budget (ChangeSet + changeset.process in one tx).
    expect(await drain(Jobs.chatMention.name)).toBe(1);
    const [reply] = chat.postedTo(TEAM, root).filter((m) => m.message.type === 'reply');
    expect(reply?.message).toEqual({ type: 'reply', text: '已送出 Brand 每日預算調整，等待審核。' });
    expect(platform.applied).toEqual([]);

    // 3. Executor: validate → Tier 2 → PENDING_APPROVAL, card in the thread plus a mirror.
    expect(await drain(Jobs.changesetProcess.name)).toBe(1);
    const card = chat.postedTo(TEAM, root).find((m) => m.message.type === 'approval_request')!;
    const cs = (card.message as Extract<ChatMessage, { type: 'approval_request' }>).changeset;
    expect(cs).toMatchObject({ status: 'PENDING_APPROVAL', tier: 2, requestedBy: 'Ren', ops: [{ before: 'NT$1,000', after: 'NT$1,100' }] });
    expect(chat.postedTo(APPROVAL.channelId).map((m) => (m.message as { mirror?: boolean }).mirror)).toEqual([true]);
    expect(await getChangeSet(t.db, cs.id)).toMatchObject({ source: { kind: 'chat', ref: { channelId: TEAM, threadId: root } }, requestedBy: { kind: 'user' } });

    // 4. A requester-only operator clicking Approve is refused (ephemeral), nothing runs.
    const click = (user: string) =>
      new URLSearchParams({
        payload: JSON.stringify({
          type: 'block_actions',
          trigger_id: 'trig',
          user: { id: user, team_id: 'T1' },
          channel: { id: TEAM },
          message: { ts: card.ref.messageId, thread_ts: root },
          actions: [{ action_id: encodeAction({ kind: 'changeset', verb: 'approve', changesetId: cs.id }) }],
        }),
      }).toString();
    expect((await slackInteractivity(signed('interactivity', click('UREQ'), 'application/x-www-form-urlencoded'))).status).toBe(200);
    expect(await drain(Jobs.chatInteraction.name)).toBe(1);
    expect(chat.ephemerals.at(-1)).toMatchObject({ userId: 'UREQ', text: '你沒有審核變更的權限。' });

    // 5. The approver's click: re-fetch, re-validate, mutate, update every card.
    expect((await slackInteractivity(signed('interactivity', click('UAPP'), 'application/x-www-form-urlencoded'))).status).toBe(200);
    expect(await drain(Jobs.chatInteraction.name)).toBe(1);

    expect(await getChangeSet(t.db, cs.id)).toMatchObject({ status: 'EXECUTED' });
    expect(platform.entity({ platform: 'google_ads', accountId: ACC, kind: 'campaign', id: '111' })?.state?.budgetMicros).toBe(1_100_000_000);
    expect(platform.applied).toHaveLength(1);
    for (const m of [card, chat.postedTo(APPROVAL.channelId)[0]!]) {
      expect(m.message).toMatchObject({ changeset: { status: 'EXECUTED', outcome: { status: 'EXECUTED', actor: 'Amy' } } });
    }
    expect((await listAudit(t.db, 'changeset', cs.id)).map((a) => a.toStatus)).toEqual(['PENDING_VALIDATION', 'PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'EXECUTED']);
  });
});
