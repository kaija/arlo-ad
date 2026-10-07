import { entityKey } from '@arlo/core';
import { describe, expect, it } from 'vitest';
import { GoogleAdsAdapter } from './adapter';
import type { GoogleAdsClient } from './client';
import campaigns from './fixtures/campaign.json';
import changeEvents from './fixtures/change_event.json';
import customer from './fixtures/customer.json';
import keywords from './fixtures/keyword_view.json';
import type { Row } from './mappers';

const ACC = '1234567890';

/** Answers by the FROM resource and records every query. */
function recordingClient(byResource: Record<string, unknown[] | ((gaql: string) => unknown[])>) {
  const queries: { customerId: string; gaql: string }[] = [];
  const client: GoogleAdsClient = {
    customer: () => {
      throw new Error('not used');
    },
    mutate: () => {
      throw new Error('not used');
    },
    keywordIdeas: () => {
      throw new Error('not used');
    },
    async query(customerId, gaql) {
      queries.push({ customerId, gaql: gaql.replace(/\s+/g, ' ').trim() });
      const from = /FROM (\w+)/.exec(gaql)?.[1] ?? '';
      const answer = byResource[from] ?? [];
      return (typeof answer === 'function' ? answer(gaql) : answer) as Row[];
    },
  };
  return { client, queries };
}

describe('GoogleAdsAdapter (reads)', () => {
  it('queries client accounts through the login customer', async () => {
    const { client, queries } = recordingClient({ customer_client: [] });
    await new GoogleAdsAdapter(client, { loginCustomerId: '111-222-3333', writeAllowedCustomerIds: [] }).listAccounts();
    expect(queries[0]).toMatchObject({ customerId: '1112223333', gaql: expect.stringContaining('FROM customer_client') });
  });

  it('fetches entities of the requested kinds once each', async () => {
    const { client, queries } = recordingClient({ campaign: campaigns, keyword_view: keywords });
    const entities = await new GoogleAdsAdapter(client, { loginCustomerId: ACC, writeAllowedCustomerIds: [] }).fetchEntities(ACC, ['campaign', 'keyword', 'campaign']);
    expect(entities.map((e) => `${e.kind}:${e.externalId}`)).toEqual(['campaign:111', 'campaign:112', 'campaign:113', 'keyword:221~3001', 'keyword:221~3002']);
    expect(queries.map((q) => /FROM (\w+)/.exec(q.gaql)?.[1])).toEqual(['campaign', 'keyword_view']);
  });

  it('builds metric queries per level and validates the range', async () => {
    const { client, queries } = recordingClient({});
    const adapter = new GoogleAdsAdapter(client, { loginCustomerId: ACC, writeAllowedCustomerIds: [] });
    await adapter.fetchMetrics({ accountId: ACC, level: 'keyword', range: { from: '2026-10-06', to: '2026-10-06' }, hourly: true });
    expect(queries[0]!.gaql).toContain("segments.hour");
    expect(queries[0]!.gaql).toContain("FROM keyword_view WHERE segments.date BETWEEN '2026-10-06' AND '2026-10-06'");
    expect(queries[0]!.gaql).not.toContain('impression_share');
    await expect(
      adapter.fetchMetrics({ accountId: ACC, level: 'campaign', range: { from: "2026-10-06' OR 1=1 --", to: '2026-10-06' } }),
    ).rejects.toThrow('invalid date range');
  });

  it('queries change history in the account timezone within the 30-day window', async () => {
    const { client, queries } = recordingClient({ customer, change_event: changeEvents });
    const now = new Date('2026-10-06T04:00:00Z');
    const adapter = new GoogleAdsAdapter(client, { loginCustomerId: ACC, writeAllowedCustomerIds: [], now: () => now });
    const events = await adapter.fetchChangeHistory(ACC, new Date('2026-01-01T00:00:00Z'));
    expect(events).toHaveLength(1);
    const gaql = queries.find((q) => q.gaql.includes('FROM change_event'))!.gaql;
    // Clamped to 29 days before now, both bounds in Asia/Taipei wall time.
    expect(gaql).toContain("change_event.change_date_time >= '2026-09-07 12:00:00'");
    expect(gaql).toContain("change_event.change_date_time <= '2026-10-06 12:00:00'");
    expect(gaql).toContain('LIMIT 10000');
  });

  it('fetches current state for campaigns and keywords keyed by entityKey', async () => {
    const { client, queries } = recordingClient({
      campaign: (gaql) => (gaql.includes('IN (111)') ? campaigns.slice(0, 1) : []),
      ad_group_criterion: keywords,
    });
    const ref = (kind: 'campaign' | 'keyword', id: string) => ({ platform: 'google_ads' as const, accountId: ACC, kind, id });
    const current = await new GoogleAdsAdapter(client, { loginCustomerId: ACC, writeAllowedCustomerIds: [] }).fetchCurrent([ref('campaign', '111'), ref('keyword', '221~3002')]);
    expect(current.get(entityKey(ref('campaign', '111')))).toMatchObject({ status: 'ENABLED', budget_micros: 3_000_000_000, target_cpa_micros: 250_000_000 });
    expect(current.get(entityKey(ref('keyword', '221~3002')))).toEqual({ status: 'PAUSED' });
    expect(current.has(entityKey(ref('keyword', '221~3001')))).toBe(false);
    expect(queries.map((q) => q.gaql).join('\n')).toContain('ad_group_criterion.criterion_id IN (3002)');
  });

  it('rejects non-numeric ids before building GAQL', async () => {
    const { client } = recordingClient({});
    await expect(
      new GoogleAdsAdapter(client, { loginCustomerId: ACC, writeAllowedCustomerIds: [] }).fetchCurrent([{ platform: 'google_ads', accountId: ACC, kind: 'campaign', id: '1) OR (1=1' }]),
    ).rejects.toThrow('invalid Google Ads id');
  });

  it('treats missing upload diagnostics as best effort', async () => {
    const { client } = recordingClient({
      customer: (gaql) => (gaql.includes('customer.time_zone') ? customer : []),
      conversion_action: [],
      offline_conversion_upload_conversion_action_summary: () => { throw new Error('PERMISSION_DENIED');
      },
    });
    await expect(new GoogleAdsAdapter(client, { loginCustomerId: ACC, writeAllowedCustomerIds: [] }).fetchConversionActions(ACC)).resolves.toEqual([]);
  });
});
