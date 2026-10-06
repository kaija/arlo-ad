import { FakeChatAdapter } from '@arlo/adapters/chat';
import { encodeAction, type Op } from '@arlo/core';
import { applyTransition, DEFAULT_ORG_ID, insertChangeSet, schema, setSlackBinding, upsertAdAccounts, upsertUserOnSignIn } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { confirmClick, openTier3Confirm } from './confirm';

const body = (payload: unknown) => new URLSearchParams({ payload: JSON.stringify(payload) }).toString();

describe('confirmClick', () => {
  const id = '0199b0c2-8f1e-7a3b-9c4d-123456789abc';
  it('extracts an approve click with its trigger and conversation', () => {
    expect(
      confirmClick(
        body({ type: 'block_actions', trigger_id: 'T.1', user: { id: 'U1' }, channel: { id: 'C1' }, message: { thread_ts: '1.2' }, actions: [{ action_id: encodeAction({ kind: 'changeset', verb: 'approve', changesetId: id }) }] }),
      ),
    ).toEqual({ triggerId: 'T.1', userId: 'U1', changesetId: id, where: { platform: 'slack', channelId: 'C1', threadId: '1.2' } });
  });

  it.each([
    ['reject clicks', { type: 'block_actions', trigger_id: 'T', user: { id: 'U1' }, actions: [{ action_id: `cs:reject:${id}` }] }],
    ['no trigger id', { type: 'block_actions', user: { id: 'U1' }, actions: [{ action_id: `cs:approve:${id}` }] }],
    ['modal submissions', { type: 'view_submission', trigger_id: 'T', user: { id: 'U1' } }],
  ])('ignores %s', (_, payload) => {
    expect(confirmClick(body(payload))).toBeNull();
  });
});

describe('openTier3Confirm', () => {
  const t = useTestDatabase();
  let accountId: string;

  beforeAll(async () => {
    const [row] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    accountId = row!.id;
    for (const [slack, role, maxTier] of [['USENIOR', 'approver', 3], ['UJUNIOR', 'approver', 2]] as const) {
      const u = await upsertUserOnSignIn(t.db, { email: `${slack.toLowerCase()}@example.com`, displayName: slack });
      await setSlackBinding(t.db, u.id, slack);
      await t.db.insert(schema.roleBindings).values({ orgId: DEFAULT_ORG_ID, userId: u.id, role, maxTier });
    }
  });

  async function pending(tier: 2 | 3) {
    const op: Op = { kind: 'set_budget', target: { platform: 'google_ads', accountId: '1234567890', kind: 'campaign', id: '111' }, field: 'budget_micros', before: 1_000_000_000, after: 2_000_000_000 };
    const cs = await insertChangeSet(t.db, { accountId, source: { kind: 'web' }, ops: [op], summary: 'double Brand', requestedBy: { kind: 'agent' } });
    const moved = await applyTransition(t.db, cs, { type: 'request_approval', tier, expiresAt: new Date(Date.now() + 3_600_000) }, { kind: 'system' });
    expect(moved.ok).toBe(true);
    return cs.id;
  }

  it('opens the modal with amounts and ratios for an authorized approver', async () => {
    const chat = new FakeChatAdapter();
    const id = await pending(3);
    const where = { platform: 'slack' as const, channelId: 'C1' };
    expect(await openTier3Confirm(t.db, chat, { triggerId: 'T.1', userId: 'USENIOR', changesetId: id, where })).toBe('opened');
    expect(chat.modals).toEqual([
      { triggerId: 'T.1', where, changeset: expect.objectContaining({ id, tier: 3, ops: [{ label: 'Campaign 111 · 每日預算', before: 'NT$1,000', after: 'NT$2,000', change: '+100.0%' }] }) },
    ]);
  });

  it('does not open for Tier 2, unauthorized or unbound users', async () => {
    const chat = new FakeChatAdapter();
    const tier2 = await pending(2);
    const tier3 = await pending(3);
    expect(await openTier3Confirm(t.db, chat, { triggerId: 'T', userId: 'USENIOR', changesetId: tier2 })).toBe('not_tier3');
    expect(await openTier3Confirm(t.db, chat, { triggerId: 'T', userId: 'UJUNIOR', changesetId: tier3 })).toBe('denied');
    expect(await openTier3Confirm(t.db, chat, { triggerId: 'T', userId: 'UNOBODY', changesetId: tier3 })).toBe('denied');
    expect(chat.modals).toEqual([]);
  });
});
