// Fixtures in ./fixtures mirror google-ads-api query results (snake_case, numeric enums,
// int64 as numbers) for the GAQL in queries.ts.
import { describe, expect, it } from 'vitest';
import adGroups from './fixtures/ad_group.json';
import campaigns from './fixtures/campaign.json';
import changeEvents from './fixtures/change_event.json';
import conversionActions from './fixtures/conversion_action.json';
import conversionActivity from './fixtures/conversion_activity.json';
import uploadSummaries from './fixtures/conversion_upload_summary.json';
import customerClients from './fixtures/customer_client.json';
import customer from './fixtures/customer.json';
import keywords from './fixtures/keyword_view.json';
import campaignDaily from './fixtures/metrics_campaign_daily.json';
import keywordHourly from './fixtures/metrics_keyword_hourly.json';
import searchTerms from './fixtures/search_term_view.json';
import sharedSets from './fixtures/shared_set.json';
import * as M from './mappers';

const rows = (json: unknown) => json as M.Row[];

describe('Google Ads mappers', () => {
  it('maps accessible client accounts', () => {
    expect(M.mapAccessibleAccounts(rows(customerClients))).toEqual([
      { externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' },
      { externalId: '2234567890', name: 'Arlo US', currency: 'USD', timezone: 'America/Los_Angeles' },
    ]);
  });

  it('maps the account entity', () => {
    expect(M.mapAccountEntity(rows(customer)[0]!)).toEqual({
      kind: 'account',
      externalId: '1234567890',
      name: 'Arlo TW',
      status: 'ENABLED',
      attrs: { currency: 'TWD', timezone: 'Asia/Taipei' },
    });
  });

  it('maps campaigns with budget and bid target state', () => {
    const [brand, generic, maxConv] = M.mapCampaigns(rows(campaigns));
    expect(brand).toEqual({
      kind: 'campaign',
      externalId: '111',
      name: 'Brand - Search',
      status: 'ENABLED',
      attrs: { channelType: 'SEARCH', budgetId: '901', budgetShared: false },
      state: { budgetMicros: 3_000_000_000, bidStrategy: 'TARGET_CPA', bidTarget: 250_000_000 },
    });
    expect(generic).toMatchObject({
      status: 'PAUSED',
      attrs: { budgetShared: true },
      state: { bidStrategy: 'MAXIMIZE_CONVERSION_VALUE', bidTarget: 4.5 },
    });
    // A zero target means "no target set".
    expect(maxConv?.state).toEqual({ budgetMicros: 500_000_000, bidStrategy: 'MAXIMIZE_CONVERSIONS', bidTarget: null });
  });

  it('derives fetchCurrent values from campaign rows', () => {
    expect(M.currentFromCampaignRow(rows(campaigns)[1]!)).toEqual({
      status: 'PAUSED',
      budget_micros: 1_500_000_000,
      bid_strategy: 'MAXIMIZE_CONVERSION_VALUE',
      target_cpa_micros: null,
      target_roas: 4.5,
    });
  });

  it('maps ad groups, keywords and negative keyword lists', () => {
    expect(M.mapAdGroups(rows(adGroups))).toEqual([
      {
        kind: 'ad_group',
        externalId: '221',
        parent: { kind: 'campaign', externalId: '111' },
        name: 'Brand exact',
        status: 'ENABLED',
        attrs: { type: 'SEARCH_STANDARD' },
      },
    ]);
    expect(M.mapKeywords(rows(keywords)).map((k) => [k.externalId, k.name, k.status, k.attrs.matchType])).toEqual([
      ['221~3001', 'arlo camera', 'ENABLED', 'EXACT'],
      ['221~3002', 'arlo doorbell', 'PAUSED', 'PHRASE'],
    ]);
    expect(M.mapSharedSets(rows(sharedSets))).toEqual([
      { kind: 'shared_set', externalId: '7001', name: 'arlo-auto-negatives', status: 'ENABLED', attrs: { type: 'NEGATIVE_KEYWORDS', memberCount: 42 } },
    ]);
  });

  it('maps daily metrics with impression share and missing metrics as zero / null', () => {
    expect(M.mapMetrics('campaign', rows(campaignDaily))).toEqual([
      {
        level: 'campaign',
        externalId: '111',
        date: '2026-10-04',
        costMicros: 1_234_500_000,
        impressions: 5400,
        clicks: 321,
        conversions: 12.5,
        convValue: 45000.25,
        searchIs: 0.8123,
        lostIsBudget: 0.05,
        lostIsRank: 0.1377,
      },
      {
        level: 'campaign',
        externalId: '112',
        date: '2026-10-04',
        costMicros: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        convValue: 0,
        searchIs: null,
        lostIsBudget: null,
        lostIsRank: null,
      },
    ]);
  });

  it('maps hourly keyword metrics to adGroupId~criterionId', () => {
    expect(M.mapMetrics('keyword', rows(keywordHourly), true)).toEqual([
      { level: 'keyword', externalId: '221~3001', date: '2026-10-06', hour: 9, costMicros: 4_500_000, impressions: 120, clicks: 7, conversions: 1, convValue: 3990 },
    ]);
  });

  it('maps change events, converting account-local time to an instant', () => {
    expect(M.mapChangeEvents(rows(changeEvents), 'Asia/Taipei')).toEqual([
      {
        externalId: 'customers/1234567890/changeEvents/1759708800000000~5~0',
        changedAt: new Date('2026-10-06T00:15:30.123Z'),
        userEmail: 'pat@example.com',
        clientType: 'GOOGLE_ADS_WEB_CLIENT',
        resourceType: 'CAMPAIGN_BUDGET',
        resourceName: 'customers/1234567890/campaignBudgets/901',
        changedFields: ['amount_micros'],
        old: { campaign_budget: { amount_micros: 2_500_000_000 } },
        new: { campaign_budget: { amount_micros: 3_000_000_000 } },
      },
    ]);
    expect(M.mapChangeEvents([{ change_event: { change_date_time: '2026-10-06 08:00:00', changed_fields: 'a,b' } } as M.Row], 'UTC')[0]?.changedFields).toEqual([
      'a',
      'b',
    ]);
  });

  it('aggregates search terms per ad group, term and date', () => {
    expect(M.mapSearchTerms(rows(searchTerms))).toEqual([
      { campaignExternalId: '111', adGroupExternalId: '221', term: 'arlo free', date: '2026-10-05', costMicros: 1_500_000, impressions: 15, clicks: 2, conversions: 0, convValue: 0 },
      { campaignExternalId: '111', adGroupExternalId: '221', term: 'arlo pro 5', date: '2026-10-05', costMicros: 8_000_000, impressions: 80, clicks: 9, conversions: 2, convValue: 7980 },
    ]);
  });

  it('maps conversion actions with last conversion time and upload diagnostics', () => {
    expect(M.mapConversionActions(rows(conversionActions), rows(conversionActivity), rows(uploadSummaries), 'Asia/Taipei')).toEqual([
      {
        externalId: '501',
        name: 'Purchase',
        status: 'ENABLED',
        category: 'PURCHASE',
        primary: true,
        // 2026-10-06 07:00 Taipei hour bucket ends at 08:00 = 00:00Z.
        lastConversionAt: new Date('2026-10-06T00:00:00Z'),
        conversions30d: 4,
        ecDiagnostics: null,
      },
      {
        externalId: '502',
        name: 'Lead upload',
        status: 'ENABLED',
        category: 'SUBMIT_LEAD_FORM',
        primary: false,
        lastConversionAt: null,
        conversions30d: 0,
        ecDiagnostics: {
          status: 'GOOD',
          totalEventCount: 40,
          successfulEventCount: 31,
          pendingEventCount: 2,
          alerts: [{ error: { conversion_upload_error: 5 }, error_percentage: 0.2 }],
        },
      },
    ]);
  });

  it('names enums from numbers or strings', () => {
    const e = { 2: 'ENABLED', ENABLED: 2 };
    expect(M.enumName(e, 2)).toBe('ENABLED');
    expect(M.enumName(e, 'PAUSED')).toBe('PAUSED');
    expect(M.enumName(e, 99)).toBe('UNKNOWN');
    expect(M.enumName(e, undefined)).toBeNull();
  });
});
