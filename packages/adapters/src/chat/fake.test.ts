import { describe, expect, it } from 'vitest';
import { FakeChatAdapter } from './fake';

describe('FakeChatAdapter', () => {
  it('posts, updates and keeps history', async () => {
    const chat = new FakeChatAdapter();
    const ref = await chat.post({ platform: 'slack', channelId: 'C1', threadId: '1.0' }, { type: 'notice', level: 'info', text: 'hi' });
    await chat.update(ref, { type: 'notice', level: 'warn', text: 'updated' });
    expect(chat.postedTo('C1', '1.0')).toHaveLength(1);
    expect(chat.find(ref)?.history.map((m) => (m.type === 'notice' ? m.text : ''))).toEqual(['hi', 'updated']);
    await expect(chat.update({ ...ref, messageId: 'nope' }, { type: 'notice', level: 'info', text: 'x' })).rejects.toThrow('message_not_found');
  });

  it('serves thread context with the root kept under a limit, and channel context', async () => {
    const chat = new FakeChatAdapter();
    chat.say('C1', 'U0', 'before');
    const root = chat.say('C1', 'U1', 'root');
    const replies = Array.from({ length: 5 }, (_, i) => chat.say('C1', 'U2', `reply ${i}`, root));
    const thread = await chat.fetchContext({ platform: 'slack', channelId: 'C1', threadId: root }, { mode: 'thread', limit: 2 });
    expect(thread.map((t) => t.text)).toEqual(['root', 'reply 3', 'reply 4']);
    const since = await chat.fetchContext({ platform: 'slack', channelId: 'C1', threadId: root }, { mode: 'thread', since: replies[3] });
    expect(since.map((t) => t.text)).toEqual(['reply 4']);
    const channel = await chat.fetchContext({ platform: 'slack', channelId: 'C1' }, { mode: 'channel', before: root });
    expect(channel.map((t) => t.text)).toEqual(['before']);
  });

  it('tracks reactions, ephemerals, users and permalinks', async () => {
    const chat = new FakeChatAdapter().addUser('U1', { email: 'pat@example.com', displayName: 'Pat' });
    const ref = { platform: 'slack' as const, channelId: 'C1', messageId: '1700000001.000100' };
    await chat.react(ref, 'hourglass_flowing_sand', true);
    await chat.react(ref, 'hourglass_flowing_sand', false);
    expect(chat.reactionLog).toEqual(['+hourglass_flowing_sand@C1:1700000001.000100', '-hourglass_flowing_sand@C1:1700000001.000100']);
    await chat.ephemeral({ platform: 'slack', channelId: 'C1' }, 'U1', 'no');
    expect(chat.ephemerals).toHaveLength(1);
    expect(await chat.resolveUser('U1')).toEqual({ email: 'pat@example.com', displayName: 'Pat' });
    expect(await chat.permalink(ref)).toBe('https://slack.test/archives/C1/p1700000001000100');
  });
});
