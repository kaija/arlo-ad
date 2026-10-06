import type { AgentInputItem } from '@openai/agents';
import { useTestDatabase } from '@arlo/db/testing';
import { describe, expect, it } from 'vitest';
import { digestSummary, PgSession, slackSessionId } from './pg-session';

const user = (text: string): AgentInputItem => ({ type: 'message', role: 'user', content: text });
const assistant = (text: string): AgentInputItem => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});
const call = (id: string): AgentInputItem => ({ type: 'function_call', callId: id, name: 'query_metrics', arguments: '{}', status: 'completed' });
const result = (id: string): AgentInputItem => ({
  type: 'function_call_result',
  callId: id,
  name: 'query_metrics',
  status: 'completed',
  output: { type: 'text', text: '{"spend":1}' },
});

describe('PgSession', () => {
  const t = useTestDatabase();
  let n = 0;
  const session = (opts: { maxItems?: number } = {}) => new PgSession({ db: t.db, sessionId: slackSessionId('C1', `1.${++n}`), ...opts });

  it('adds, gets (with limit), pops and clears items in order', async () => {
    const s = session();
    expect(await s.getSessionId()).toMatch(/^slack:C1:1\.\d+$/);
    expect(await s.getItems()).toEqual([]);
    await s.addItems([user('昨天花多少？'), call('c1'), result('c1')]);
    await s.addItems([assistant('NT$12,345')]);
    expect(await s.getItems()).toEqual([user('昨天花多少？'), call('c1'), result('c1'), assistant('NT$12,345')]);
    expect(await s.getItems(2)).toEqual([result('c1'), assistant('NT$12,345')]);

    expect(await s.popItem()).toEqual(assistant('NT$12,345'));
    expect(await s.getItems()).toHaveLength(3);

    await s.clearSession();
    expect(await s.getItems()).toEqual([]);
    expect(await s.popItem()).toBeUndefined();
  });

  it('keeps sessions separate by thread', async () => {
    const a = session();
    const b = session();
    await a.addItems([user('a')]);
    await b.addItems([user('b')]);
    expect(await a.getItems()).toEqual([user('a')]);
    expect(await b.getItems()).toEqual([user('b')]);
  });

  it('keeps the most recent items and replays a summary of the rest', async () => {
    const s = session({ maxItems: 3 });
    await s.addItems([user('第一個問題'), assistant('第一個回答')]);
    await s.addItems([user('第二個問題'), assistant('第二個回答')]);
    const items = await s.getItems();
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ type: 'message', role: 'system', content: expect.stringContaining('user: 第一個問題') });
    expect(items.slice(1)).toEqual([assistant('第一個回答'), user('第二個問題'), assistant('第二個回答')]);
  });

  it('never keeps a tool result without its call', async () => {
    const s = session({ maxItems: 2 });
    await s.addItems([user('q'), call('c9'), result('c9'), assistant('a')]);
    const items = await s.getItems();
    // Cutting at 2 would keep result('c9') without call('c9'); the cut moves past it.
    expect(items.slice(1)).toEqual([assistant('a')]);
    expect(items[0]).toMatchObject({ role: 'system', content: expect.stringContaining('[tool query_metrics]') });
  });

  it('serializes concurrent appends without losing items', async () => {
    const s = session();
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.addItems([user(`m${i}`)])));
    expect((await s.getItems()).map((i) => (i as { content: string }).content).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${i}`).sort(),
    );
  });

  it('tracks the last Slack message folded into the session', async () => {
    const s = session();
    expect(await s.getLastSlackTs()).toBeNull();
    await s.setLastSlackTs('1700000005.000100');
    expect(await s.getLastSlackTs()).toBe('1700000005.000100');
  });

  it('caps the digest length, keeping the most recent text', () => {
    const long = Array.from({ length: 50 }, (_, i) => user(`${i} ${'x'.repeat(200)}`));
    const summary = digestSummary(long, null);
    expect(summary.length).toBeLessThanOrEqual(4001);
    expect(summary).toContain('user: 49');
  });
});
