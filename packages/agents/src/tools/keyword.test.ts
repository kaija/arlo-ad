import { EMPTY_BUSINESS_PROFILE } from '@arlo/core';
import { DEFAULT_ORG_ID, getChangeSet, insertChangeSet, saveBusinessProfile, saveSearchTermLabels, upsertAdAccounts, upsertEntities, upsertSearchTerms, upsertUserOnSignIn } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../context';
import { runGetBusinessProfile, runGetSearchTerms, runProposeNegativeKeywords } from './keyword';

describe('get_business_profile', () => {
  const t = useTestDatabase();
  const ctx = (allowed: string[] | null = null): AgentContext => ({ db: t.db, allowedAccountIds: allowed, now: () => new Date() });

  it('returns the latest version within scope, or a hint when missing', async () => {
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    expect(await runGetBusinessProfile(ctx(), { account: 'Arlo TW' })).toMatchObject({ version: null, profile: null });
    await saveBusinessProfile(t.db, acc!.id, { ...EMPTY_BUSINESS_PROFILE, brandTerms: ['arlo'] }, { kind: 'system' });
    expect(await runGetBusinessProfile(ctx(), { account: '123-456-7890' })).toMatchObject({ version: 1, profile: { brandTerms: ['arlo'] } });
    await expect(runGetBusinessProfile(ctx([]), { account: 'Arlo TW' })).rejects.toThrow('找不到');
  });
});

describe('search term tools', () => {
  const t = useTestDatabase();
  const now = () => new Date('2026-10-07T04:00:00Z');

  it('lists spending terms with labels and proposes negatives into the auto list', async () => {
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    const [list, campaign] = await upsertEntities(t.db, [
      { orgId: DEFAULT_ORG_ID, accountId: acc!.id, kind: 'shared_set', externalId: '777', name: 'arlo-auto-negatives', status: 'ENABLED' },
      { orgId: DEFAULT_ORG_ID, accountId: acc!.id, kind: 'campaign', externalId: '111', name: 'Generic', status: 'ENABLED' },
    ]);
    void list;
    const [adGroup] = await upsertEntities(t.db, [{ orgId: DEFAULT_ORG_ID, accountId: acc!.id, kind: 'ad_group', externalId: '221', parentId: campaign!.id, name: 'Main', status: 'ENABLED' }]);
    const row = (term: string, cost: number, conversions: number) => ({ orgId: DEFAULT_ORG_ID, accountId: acc!.id, campaignId: campaign!.id, adGroupId: adGroup!.id, term, date: '2026-10-05', costMicros: cost * 1_000_000, impressions: 10, clicks: 2, conversions, convValue: 0 });
    await upsertSearchTerms(t.db, [row('Free  Camera', 30, 0), row('buy camera', 80, 2)]);
    const profile = await saveBusinessProfile(t.db, acc!.id, EMPTY_BUSINESS_PROFILE, { kind: 'system' });
    await saveSearchTermLabels(t.db, acc!.id, profile.version, [{ term: 'free camera', intent: 'free_or_diy', relevant: false, confidence: 0.95, reason: '免費' }], 'small');

    const ctx: AgentContext = {
      db: t.db,
      allowedAccountIds: null,
      now,
      user: { id: (await upsertUserOnSignIn(t.db, { email: 'nobody@example.com' })).id },
      propose: async (input) => ({ id: (await insertChangeSet(t.db, input)).id }),
    };
    const listed = await runGetSearchTerms({ ...ctx, user: null }, { account: 'Arlo TW', days: null, limit: null, onlyWithoutConversions: true });
    expect(listed.terms).toEqual([{ term: 'free camera', cost: 30, clicks: 2, conversions90d: 0, label: { intent: 'free_or_diy', relevant: false, confidence: 0.95, reason: '免費' } }]);

    // A user without operator rights cannot propose.
    await expect(runProposeNegativeKeywords(ctx, { account: 'Arlo TW', terms: ['free camera'], matchType: 'EXACT', campaign: null, reason: null })).rejects.toThrow('operator');
    const out = await runProposeNegativeKeywords({ ...ctx, user: null }, { account: 'Arlo TW', terms: ['Free Camera', 'free camera'], matchType: 'EXACT', campaign: null, reason: '免費' });
    expect((await getChangeSet(t.db, out.changesetId))?.ops).toEqual([
      { kind: 'google.add_negative_keyword', target: { platform: 'google_ads', accountId: '1234567890', kind: 'shared_set', id: '777' }, before: null, after: { text: 'free camera', matchType: 'EXACT' } },
    ]);
    const onCampaign = await runProposeNegativeKeywords({ ...ctx, user: null }, { account: 'Arlo TW', terms: ['jobs'], matchType: 'PHRASE', campaign: 'Generic', reason: null });
    expect((await getChangeSet(t.db, onCampaign.changesetId))?.ops[0]?.target).toMatchObject({ kind: 'campaign', id: '111' });
  });
});
