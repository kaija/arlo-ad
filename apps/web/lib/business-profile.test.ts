import { EMPTY_BUSINESS_PROFILE } from '@arlo/core';
import { addProfileExample, DEFAULT_ORG_ID, getBusinessProfile, listAudit, listProfileVersions, saveBusinessProfile, schema, upsertAdAccounts } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { describe, expect, it } from 'vitest';
import { parseProfileForm, profileToForm } from './business-profile';

describe('profile form', () => {
  const values = {
    offerings: '家用監視器\n\n Video Doorbell ',
    targetIntents: '購買\n比較',
    excludedIntents: '免費\n求職',
    brandTerms: 'arlo',
    competitorPolicy: 'exclude',
    examples: 'arlo login | 不相關 | 客服\nbest security camera | 相關',
  };

  it('parses one item per line and round-trips', () => {
    const parsed = parseProfileForm(values);
    expect(parsed).toEqual({
      ok: true,
      value: {
        offerings: ['家用監視器', 'Video Doorbell'],
        targetIntents: ['購買', '比較'],
        excludedIntents: ['免費', '求職'],
        brandTerms: ['arlo'],
        competitorPolicy: 'exclude',
        examples: [
          { term: 'arlo login', relevant: false, note: '客服' },
          { term: 'best security camera', relevant: true, note: null },
        ],
      },
    });
    if (parsed.ok) expect(parseProfileForm(profileToForm(parsed.value))).toEqual(parsed);
  });

  it('reports bad example lines and policies', () => {
    expect(parseProfileForm({ ...values, examples: 'ok | 相關\nbroken line', competitorPolicy: 'bid' })).toEqual({
      ok: false,
      errors: { examples: { key: 'exampleLineFormat', values: { line: 2 } }, competitorPolicy: 'chooseCompetitorPolicy' },
    });
  });
});

describe('profile versions', () => {
  const t = useTestDatabase();
  const actor = { kind: 'system' as const };

  it('saves each edit as the next version and adds examples as new versions', async () => {
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    expect(await getBusinessProfile(t.db, acc!.id)).toBeUndefined();
    const v1 = await addProfileExample(t.db, acc!.id, { term: 'arlo jobs', relevant: false, note: null }, actor);
    expect(v1).toMatchObject({ version: 1, profile: { examples: [{ term: 'arlo jobs' }] } });
    await Promise.all([saveBusinessProfile(t.db, acc!.id, { ...v1.profile, brandTerms: ['arlo'] }, actor), saveBusinessProfile(t.db, acc!.id, EMPTY_BUSINESS_PROFILE, actor)]);
    expect((await listProfileVersions(t.db, acc!.id)).map((v) => v.version)).toEqual([3, 2, 1]);
    expect((await getBusinessProfile(t.db, acc!.id, 1))?.profile.examples).toHaveLength(1);
    await expect(saveBusinessProfile(t.db, acc!.id, { ...EMPTY_BUSINESS_PROFILE, competitorPolicy: 'bid' as never }, actor)).rejects.toThrow();
    expect((await getBusinessProfile(t.db, acc!.id))?.version).toBe(3);
    const first = (await t.db.select().from(schema.businessProfiles)).find((r) => r.version === 1);
    expect((await listAudit(t.db, 'business_profile', first!.id)).map((a) => a.payload)).toEqual([{ accountId: acc!.id, version: 1 }]);
  });
});
