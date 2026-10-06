import { describe, expect, it } from 'vitest';
import { entityKey, type EntityKind, type Op } from '../platform/types';
import type { ChangeSet } from './types';
import { changeSetView, opView } from './view';

const ref = (kind: EntityKind, id: string) => ({ platform: 'google_ads' as const, accountId: '1234567890', kind, id });
const names = new Map([[entityKey(ref('campaign', '111')), 'Brand']]);

describe('opView', () => {
  it.each<[string, Op, ReturnType<typeof opView>]>([
    [
      'budget',
      { kind: 'set_budget', target: ref('campaign', '111'), field: 'budget_micros', before: 1_000_000_000, after: 800_000_000 },
      { label: 'Brand · 每日預算', before: 'NT$1,000', after: 'NT$800', change: '-20.0%' },
    ],
    ['status', { kind: 'set_status', target: ref('keyword', '1~2'), field: 'status', before: 'ENABLED', after: 'PAUSED' }, { label: '關鍵字 1~2 · 狀態', before: '啟用', after: '暫停' }],
    [
      'tROAS',
      { kind: 'set_bid_target', target: ref('campaign', '111'), field: 'target_roas', before: 4, after: 4.4 },
      { label: 'Brand · 目標 ROAS', before: '400%', after: '440%', change: '+10.0%' },
    ],
    [
      'negative keyword',
      { kind: 'google.add_negative_keyword', target: ref('shared_set', '9'), before: null, after: { text: 'free', matchType: 'EXACT' } },
      { label: '否定關鍵字清單 9 · 新增否定關鍵字', before: '—', after: 'free [EXACT]' },
    ],
  ])('%s', (_, op, view) => {
    expect(opView(op, { currency: 'TWD', names })).toEqual(view);
  });
});

describe('changeSetView', () => {
  const cs: ChangeSet = {
    id: '0199',
    orgId: 'org',
    platform: 'google_ads',
    accountId: 'acc',
    source: { kind: 'chat' },
    ops: [
      { kind: 'set_budget', target: ref('campaign', '111'), field: 'budget_micros', before: 1_000_000, after: 2_000_000 },
      { kind: 'set_status', target: ref('campaign', '111'), field: 'status', before: 'PAUSED', after: 'ENABLED' },
    ],
    summary: 'Raise Brand',
    rationale: 'IS lost to budget',
    tier: 2,
    status: 'PENDING_APPROVAL',
    violations: [{ ruleId: 'r', ruleType: 'MaxChangePct', severity: 'WARN', message: 'too fast' }],
    requestedBy: { kind: 'agent' },
    expiresAt: new Date('2026-10-08T00:00:00Z'),
    createdAt: new Date('2026-10-07T00:00:00Z'),
  };

  it('builds the card view with excluded ops and optional fields', () => {
    const view = changeSetView(cs, { accountName: 'Acme', currency: 'USD', names, requestedBy: 'Ann', excludedOps: new Set([1]) });
    expect(view).toMatchObject({
      id: '0199',
      accountName: 'Acme',
      tier: 2,
      status: 'PENDING_APPROVAL',
      rationale: 'IS lost to budget',
      requestedBy: 'Ann',
      expiresAt: '2026-10-08T00:00:00.000Z',
      violations: [{ severity: 'WARN', message: 'too fast' }],
    });
    expect(view.ops[0]).toEqual({ label: 'Brand · 每日預算', before: '$1.00', after: '$2.00', change: '+100.0%' });
    expect(view.ops[1]!.excluded).toBe(true);
    expect(view).not.toHaveProperty('outcome');
  });
});
