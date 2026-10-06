import type { WebClient } from '@slack/web-api';
import { describe, expect, it, vi } from 'vitest';
import { SlackAdapter } from './adapter';

function stubClient() {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, result: unknown) =>
    vi.fn(async (args: unknown) => {
      (calls[name] ??= []).push(args);
      return typeof result === 'function' ? (result as (a: unknown) => unknown)(args) : result;
    });
  const client = {
    chat: {
      postMessage: record('postMessage', { ok: true, channel: 'C1', ts: '1700000001.000100' }),
      update: record('update', { ok: true }),
      postEphemeral: record('postEphemeral', { ok: true }),
      getPermalink: record('getPermalink', { ok: true, permalink: 'https://arlo.slack.com/archives/C1/p1700000001000100' }),
    },
    conversations: {
      replies: record('replies', (args: { cursor?: string }) =>
        args.cursor
          ? { messages: [{ ts: '1.4', user: 'U2', text: 'later' }], response_metadata: {} }
          : {
              messages: [
                { ts: '1.1', user: 'U1', text: 'root' },
                { ts: '1.2', bot_id: 'B1', user: 'UBOT', text: 'bot reply' },
                { ts: '1.3', user: 'U2', subtype: 'channel_join', text: 'joined' },
              ],
              response_metadata: { next_cursor: 'next' },
            },
      ),
      history: record('history', { messages: [{ ts: '2.3', user: 'U3', text: 'newest' }, { ts: '2.2', user: 'U2', text: 'older' }] }),
    },
    users: { info: record('info', { user: { name: 'pat', real_name: 'Pat Lee', profile: { email: 'pat@example.com', display_name: '' } } }) },
    reactions: {
      add: record('reactionsAdd', () => Promise.reject(Object.assign(new Error('already'), { data: { error: 'already_reacted' } }))),
      remove: record('reactionsRemove', () => Promise.reject(Object.assign(new Error('rate'), { data: { error: 'ratelimited' } }))),
    },
  };
  return { client: client as unknown as WebClient, calls };
}

describe('SlackAdapter', () => {
  it('posts rendered blocks into a thread and updates them', async () => {
    const { client, calls } = stubClient();
    const slack = new SlackAdapter(client);
    const ref = await slack.post({ platform: 'slack', channelId: 'C1', threadId: '1.1' }, { type: 'notice', level: 'info', text: 'done' });
    expect(ref).toEqual({ platform: 'slack', channelId: 'C1', messageId: '1700000001.000100', threadId: '1.1' });
    expect(calls.postMessage![0]).toMatchObject({ channel: 'C1', thread_ts: '1.1', text: 'done', unfurl_links: false });
    await slack.update(ref, { type: 'notice', level: 'warn', text: 'changed' });
    expect(calls.update![0]).toMatchObject({ channel: 'C1', ts: '1700000001.000100', text: 'changed' });
  });

  it('reads a whole thread across pages, skipping system messages, keeping the root under a limit', async () => {
    const { client } = stubClient();
    const slack = new SlackAdapter(client);
    const turns = await slack.fetchContext({ platform: 'slack', channelId: 'C1', threadId: '1.1' }, { mode: 'thread', limit: 1 });
    expect(turns).toEqual([
      { messageId: '1.1', userId: 'U1', bot: false, text: 'root' },
      { messageId: '1.4', userId: 'U2', bot: false, text: 'later' },
    ]);
    const since = await slack.fetchContext({ platform: 'slack', channelId: 'C1', threadId: '1.1' }, { mode: 'thread', since: '1.1' });
    expect(since.map((t) => [t.messageId, t.bot])).toEqual([
      ['1.2', true],
      ['1.4', false],
    ]);
  });

  it('reads channel history oldest first', async () => {
    const { client, calls } = stubClient();
    const turns = await new SlackAdapter(client).fetchContext({ platform: 'slack', channelId: 'C1' }, { mode: 'channel', before: '2.9', limit: 10 });
    expect(turns.map((t) => t.text)).toEqual(['older', 'newest']);
    expect(calls.history![0]).toMatchObject({ channel: 'C1', latest: '2.9', inclusive: false, limit: 10 });
  });

  it('resolves users once and builds permalinks', async () => {
    const { client, calls } = stubClient();
    const slack = new SlackAdapter(client);
    expect(await slack.resolveUser('U1')).toEqual({ email: 'pat@example.com', displayName: 'Pat Lee' });
    await slack.resolveUser('U1');
    expect(calls.info).toHaveLength(1);
    expect(await slack.permalink({ platform: 'slack', channelId: 'C1', messageId: '1.1' })).toContain('/archives/C1/');
  });

  it('tolerates duplicate reactions but surfaces other errors', async () => {
    const { client } = stubClient();
    const slack = new SlackAdapter(client);
    const ref = { platform: 'slack' as const, channelId: 'C1', messageId: '1.1' };
    await expect(slack.react(ref, 'hourglass_flowing_sand', true)).resolves.toBeUndefined();
    await expect(slack.react(ref, 'hourglass_flowing_sand', false)).rejects.toThrow('rate');
  });

  it('sends ephemeral messages to one user', async () => {
    const { client, calls } = stubClient();
    await new SlackAdapter(client).ephemeral({ platform: 'slack', channelId: 'C1', threadId: '1.1' }, 'U9', '沒有權限');
    expect(calls.postEphemeral![0]).toEqual({ channel: 'C1', user: 'U9', thread_ts: '1.1', text: '沒有權限' });
  });
});
