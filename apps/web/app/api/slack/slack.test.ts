import { signSlackRequest } from '@arlo/adapters/chat';
import { createLogger } from '@arlo/config/logger';
import { useTestDatabase } from '@arlo/db/testing';
import { ALL_JOBS, createBoss, ensureQueues, Jobs } from '@arlo/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBoss } from '../../../lib/queue';
import { getPool } from '../../../lib/server';
import { POST as events } from './events/route';
import { POST as interactivity } from './interactivity/route';

const SECRET = 'test-signing-secret';
const now = () => String(Math.floor(Date.now() / 1000));

function slackRequest(path: string, body: string, opts: { timestamp?: string; secret?: string; contentType?: string } = {}) {
  const timestamp = opts.timestamp ?? now();
  return new Request(`http://localhost/api/slack/${path}`, {
    method: 'POST',
    headers: {
      'content-type': opts.contentType ?? 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signSlackRequest(opts.secret ?? SECRET, timestamp, body),
    },
    body,
  });
}

const mention = (eventId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'event_callback',
    event_id: eventId,
    team_id: 'T1',
    event: { type: 'app_mention', user: 'U1', text: '<@UBOT> 昨天花多少', ts: '1700000002.000100', channel: 'C1', ...extra },
  });

describe('Slack endpoints', () => {
  const t = useTestDatabase();

  beforeAll(async () => {
    process.env.DATABASE_URL = t.url;
    process.env.SLACK_SIGNING_SECRET = SECRET;
    const migrator = createBoss({ connectionString: t.url, logger: createLogger({ component: 'test', level: 'silent' }), role: 'migrator' });
    await migrator.start();
    await ensureQueues(migrator, ALL_JOBS);
    await migrator.stop({ graceful: false, close: true });
  });

  afterAll(async () => {
    await (await getBoss()).stop({ graceful: false, close: true });
    await getPool().end();
  });

  const jobs = async (name: string) => (await getBoss()).findJobs(name);

  describe('POST /api/slack/events', () => {
    it('answers the URL verification challenge', async () => {
      const res = await events(slackRequest('events', JSON.stringify({ type: 'url_verification', challenge: 'abc' })));
      expect(await res.json()).toEqual({ challenge: 'abc' });
    });

    it('enqueues an app_mention once, even when Slack retries the event', async () => {
      expect((await events(slackRequest('events', mention('Ev1')))).status).toBe(200);
      expect((await events(slackRequest('events', mention('Ev1')))).status).toBe(200);
      const queued = await jobs(Jobs.chatMention.name);
      expect(queued.map((j) => j.data)).toEqual([
        { eventId: 'Ev1', teamId: 'T1', channelId: 'C1', userId: 'U1', text: '<@UBOT> 昨天花多少', messageTs: '1700000002.000100' },
      ]);
    });

    it('keeps the thread of a mention inside a thread', async () => {
      await events(slackRequest('events', mention('Ev2', { ts: '1700000009.000100', thread_ts: '1700000001.000100' })));
      const queued = await jobs(Jobs.chatMention.name);
      expect(queued.find((j) => (j.data as { eventId: string }).eventId === 'Ev2')?.data).toMatchObject({ threadTs: '1700000001.000100' });
    });

    it('ignores bot messages and other events', async () => {
      await events(slackRequest('events', mention('Ev3', { bot_id: 'B1' })));
      await events(slackRequest('events', JSON.stringify({ type: 'event_callback', event_id: 'Ev4', event: { type: 'reaction_added' } })));
      expect((await jobs(Jobs.chatMention.name)).map((j) => (j.data as { eventId: string }).eventId).sort()).toEqual(['Ev1', 'Ev2']);
    });

    it.each([
      ['wrong secret', { secret: 'other' }],
      ['expired timestamp', { timestamp: String(Math.floor(Date.now() / 1000) - 600) }],
    ])('rejects a request with %s', async (_, opts) => {
      const res = await events(slackRequest('events', mention('Ev5'), opts));
      expect(res.status).toBe(401);
    });

    it('rejects a valid signature over a tampered body', async () => {
      const req = slackRequest('events', mention('Ev6'));
      const tampered = new Request(req.url, { method: 'POST', headers: req.headers, body: mention('Ev6', { text: 'evil' }) });
      expect((await events(tampered)).status).toBe(401);
    });

    it('rejects malformed JSON with 400', async () => {
      expect((await events(slackRequest('events', 'not json'))).status).toBe(400);
    });
  });

  describe('POST /api/slack/interactivity', () => {
    it('enqueues a button click', async () => {
      const payload = {
        type: 'block_actions',
        user: { id: 'U2', team_id: 'T1' },
        channel: { id: 'C1' },
        message: { ts: '1700000003.000100', thread_ts: '1700000001.000100' },
        response_url: 'https://hooks.slack.com/actions/x',
        actions: [{ action_id: 'cs:approve:0190', value: 'v' }],
      };
      const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
      const res = await interactivity(slackRequest('interactivity', body, { contentType: 'application/x-www-form-urlencoded' }));
      expect(res.status).toBe(200);
      expect((await jobs(Jobs.chatInteraction.name)).map((j) => j.data)).toEqual([
        {
          type: 'block_actions',
          userId: 'U2',
          teamId: 'T1',
          channelId: 'C1',
          messageTs: '1700000003.000100',
          threadTs: '1700000001.000100',
          actions: [{ actionId: 'cs:approve:0190', value: 'v' }],
          responseUrl: 'https://hooks.slack.com/actions/x',
        },
      ]);
    });

    it('rejects unsigned requests', async () => {
      const req = new Request('http://localhost/api/slack/interactivity', { method: 'POST', body: 'payload={}' });
      expect((await interactivity(req)).status).toBe(401);
    });
  });
});
