import { EMPTY_BUSINESS_PROFILE, type Op } from '@arlo/core';
import { applyTransition, DEFAULT_ORG_ID, insertChangeSet, resolveAccounts, saveBusinessProfile, saveSearchTermLabels, setOpExcluded, upsertAdAccounts, upsertEntities, upsertSearchTerms, type AdAccount } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSearchTerms, parseTermFilter } from './search-terms';

const NOW = new Date('2026-10-07T04:00:00Z');

describe('parseTermFilter', () => {
  it('defaults and validates', () => {
    expect(parseTermFilter({})).toEqual({ days: 30, label: 'all', q: '' });
    expect(parseTermFilter({ days: '7', label: 'negated', q: ' cam ' })).toEqual({ days: 7, label: 'negated', q: 'cam' });
    expect(parseTermFilter({ days: '5', label: 'nope' })).toEqual({ days: 30, label: 'all', q: '' });
  });
});

describe('loadSearchTerms', () => {
  const t = useTestDatabase();
  let account: AdAccount;

  beforeAll(async () => {
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    account = (await resolveAccounts(t.db, { allowed: null }))[0]!;
    const [campaign] = await upsertEntities(t.db, [{ orgId: DEFAULT_ORG_ID, accountId: acc!.id, kind: 'campaign', externalId: '111', name: 'G' }]);
    const [adGroup] = await upsertEntities(t.db, [{ orgId: DEFAULT_ORG_ID, accountId: acc!.id, kind: 'ad_group', externalId: '221', parentId: campaign!.id }]);
    const row = (term: string, date: string, cost: number) => ({ orgId: DEFAULT_ORG_ID, accountId: acc!.id, campaignId: campaign!.id, adGroupId: adGroup!.id, term, date, costMicros: cost * 1_000_000, impressions: 10, clicks: 1, conversions: 0, convValue: 0 });
    await upsertSearchTerms(t.db, [row('free camera', '2026-10-05', 30), row('buy camera', '2026-10-05', 80), row('camera manual', '2026-10-05', 5), row('old', '2026-08-01', 9)]);
    const profile = await saveBusinessProfile(t.db, acc!.id, EMPTY_BUSINESS_PROFILE, { kind: 'system' });
    await saveSearchTermLabels(t.db, acc!.id, profile.version, [
      { term: 'free camera', intent: 'free_or_diy', relevant: false, confidence: 0.95, reason: 'r' },
      { term: 'buy camera', intent: 'purchase', relevant: true, confidence: 0.9, reason: 'r' },
    ], null);
    const op = (text: string): Op => ({ kind: 'google.add_negative_keyword', target: { platform: 'google_ads', accountId: '1234567890', kind: 'shared_set', id: '7' }, before: null, after: { text, matchType: 'EXACT' }, meta: { minTier: 2 } });
    const cs = await insertChangeSet(t.db, { accountId: acc!.id, source: { kind: 'schedule' }, ops: [op('free camera'), op('camera manual')], summary: 'batch', requestedBy: { kind: 'system' } });
    const pending = await applyTransition(t.db, cs, { type: 'request_approval', tier: 2, expiresAt: NOW }, { kind: 'system' });
    if (pending.ok) await setOpExcluded(t.db, cs.id, 1, true, { kind: 'system' });
  });

  it('joins spend, labels and negative history, with filters', async () => {
    const all = await loadSearchTerms(t.db, account, { days: 30, label: 'all', q: '' }, NOW);
    expect(all.profileVersion).toBe(1);
    expect(all.rows.map((r) => r.term)).toEqual(['buy camera', 'free camera', 'camera manual']);
    expect(all.rows.find((r) => r.term === 'free camera')).toMatchObject({ label: { relevant: false }, negative: { status: 'PENDING_APPROVAL', excluded: false } });
    expect(all.rows.find((r) => r.term === 'camera manual')).toMatchObject({ label: null, negative: { excluded: true } });
    expect(all.history.map((h) => [h.term, h.excluded])).toEqual([
      ['free camera', false],
      ['camera manual', true],
    ]);
    const pick = async (label: 'irrelevant' | 'relevant' | 'unlabelled' | 'negated', q = '') => (await loadSearchTerms(t.db, account, { days: 30, label, q }, NOW)).rows.map((r) => r.term);
    expect(await pick('irrelevant')).toEqual(['free camera']);
    expect(await pick('relevant')).toEqual(['buy camera']);
    expect(await pick('unlabelled')).toEqual(['camera manual']);
    expect(await pick('negated')).toEqual(['free camera']);
    expect((await loadSearchTerms(t.db, account, { days: 90, label: 'all', q: 'OLD' }, NOW)).rows.map((r) => r.term)).toEqual(['old']);
  });
});
