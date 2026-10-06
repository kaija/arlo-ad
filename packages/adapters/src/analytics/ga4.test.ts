import { describe, expect, it } from 'vitest';
import { FakeGa4Adapter, mapGa4Report } from './ga4';

describe('GA4 adapter', () => {
  it('maps report rows and skips malformed dates', () => {
    expect(
      mapGa4Report({
        rows: [
          { dimensionValues: [{ value: '20261005' }, { value: 'google / cpc' }], metricValues: [{ value: '120' }, { value: '7.5' }] },
          { dimensionValues: [{ value: '(other)' }, { value: 'google / cpc' }], metricValues: [{ value: '1' }, { value: '0' }] },
        ],
      }),
    ).toEqual([{ date: '2026-10-05', sourceMedium: 'google / cpc', sessions: 120, conversions: 7.5 }]);
    expect(mapGa4Report({})).toEqual([]);
  });

  it('serves seeded rows within the range', async () => {
    const fake = new FakeGa4Adapter().set('123', [
      { date: '2026-10-01', sourceMedium: 'google / cpc', sessions: 1, conversions: 1 },
      { date: '2026-10-05', sourceMedium: 'google / cpc', sessions: 2, conversions: 2 },
    ]);
    expect((await fake.fetchDaily('123', { from: '2026-10-02', to: '2026-10-06' })).map((r) => r.date)).toEqual(['2026-10-05']);
  });
});
