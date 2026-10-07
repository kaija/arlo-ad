// Contract test against a Google Ads test account (ADR-0026). Manual: `pnpm test:contract`.
// Writes only to the first account in ADS_WRITE_ALLOWED_CUSTOMER_IDS, which must be a test
// account; every change is reverted or harmless (unique negative keyword in a shared set).
import { EnvSchema, parseEnv } from '@arlo/config';
import type { CampaignBundle, Op } from '@arlo/core';
import { describe, expect, it } from 'vitest';
import { GoogleAdsAdapter } from './adapter';
import { createGoogleAdsClient } from './client';

const env = parseEnv(
  EnvSchema.pick({
    GOOGLE_ADS_DEVELOPER_TOKEN: true,
    GOOGLE_ADS_CLIENT_ID: true,
    GOOGLE_ADS_CLIENT_SECRET: true,
    GOOGLE_ADS_REFRESH_TOKEN: true,
    GOOGLE_ADS_LOGIN_CUSTOMER_ID: true,
    ADS_WRITE_ALLOWED_CUSTOMER_IDS: true,
  }),
);
const accountId = env.ADS_WRITE_ALLOWED_CUSTOMER_IDS[0];
const adapter = new GoogleAdsAdapter(
  createGoogleAdsClient({
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
    clientId: env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
  }),
  { loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID, writeAllowedCustomerIds: env.ADS_WRITE_ALLOWED_CUSTOMER_IDS },
);
const ref = (kind: Op['target']['kind'], id: string) => ({ platform: 'google_ads' as const, accountId: accountId!, kind, id });

describe.skipIf(!accountId)('GoogleAdsAdapter contract (test account)', () => {
  it('round-trips a campaign budget and status', async () => {
    const campaigns = await adapter.fetchEntities(accountId!, ['campaign']);
    const campaign = campaigns.find((c) => !c.attrs.budgetShared && c.state?.budgetMicros);
    expect(campaign, 'test account needs a campaign with its own budget').toBeDefined();
    const { budgetMicros } = campaign!.state!;
    const target = ref('campaign', campaign!.externalId);

    const bumped = await adapter.applyOps(accountId!, [
      { kind: 'set_budget', target, field: 'budget_micros', before: budgetMicros, after: budgetMicros! + 1_000_000 },
      { kind: 'set_status', target, field: 'status', before: campaign!.status, after: campaign!.status },
    ]);
    expect(bumped.map((r) => r.error ?? 'ok')).toEqual(['ok', 'ok']);
    const current = await adapter.fetchCurrent([target]);
    expect([...current.values()][0]?.budget_micros).toBe(budgetMicros! + 1_000_000);

    const restored = await adapter.applyOps(accountId!, [
      { kind: 'set_budget', target, field: 'budget_micros', before: budgetMicros! + 1_000_000, after: budgetMicros },
    ]);
    expect(restored[0]?.ok).toBe(true);
  });

  it('adds a negative keyword to a shared set', async () => {
    const [set] = await adapter.fetchEntities(accountId!, ['shared_set']);
    if (!set) return;
    const [result] = await adapter.applyOps(accountId!, [
      { kind: 'google.add_negative_keyword', target: ref('shared_set', set.externalId), before: null, after: { text: `arlo contract ${Date.now()}`, matchType: 'EXACT' } },
    ]);
    expect(result).toMatchObject({ ok: true, resourceName: expect.stringContaining('/sharedCriteria/') });
  });

  it('creates a paused Search campaign bundle atomically', async () => {
    const stamp = Date.now();
    const bundle: CampaignBundle = {
      name: `arlo contract ${stamp}`,
      budgetMicros: 10_000_000,
      biddingStrategy: 'MAXIMIZE_CONVERSIONS',
      targetCpaMicros: null,
      geoTargetIds: [2158],
      languageIds: [1018],
      adGroups: [
        {
          name: 'contract',
          keywords: [{ text: `arlo contract ${stamp}`, matchType: 'EXACT' }],
          ads: [{ headlines: ['Arlo 監視器', '無線免佈線', '官方網站'], descriptions: ['合約測試廣告，不會投放。', '建立後保持暫停。'], finalUrl: 'https://www.arlo.com/', path1: null, path2: null }],
        },
      ],
      negativeKeywords: [{ text: '免費', matchType: 'PHRASE' }],
      status: 'PAUSED',
    };
    const [result] = await adapter.applyOps(accountId!, [{ kind: 'google.create_campaign_bundle', target: ref('account', accountId!), before: null, after: bundle }]);
    expect(result).toMatchObject({ ok: true, resourceName: expect.stringMatching(/\/campaigns\/\d+$/) });
    const id = /campaigns\/(\d+)$/.exec(result!.resourceName!)![1]!;
    const current = await adapter.fetchCurrent([ref('campaign', id)]);
    expect([...current.values()][0]?.status).toBe('PAUSED');
  });

  it('refuses accounts outside the allowlist', async () => {
    await expect(adapter.applyOps('0000000000', [])).rejects.toThrow('ADS_WRITE_ALLOWED_CUSTOMER_IDS');
  });
});
