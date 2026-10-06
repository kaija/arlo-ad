import { describe, expect, it } from 'vitest';
import { addDays } from '../time';
import { clicksWithoutSessions, detectMetricAnomalies, detectSegmentAnomalies, median, robustZ, type DailyPoint } from './anomaly';

const M = 1_000_000;
// 28 days of steady traffic with some noise, then `today`.
const series = (today: Partial<DailyPoint>): DailyPoint[] => [
  ...Array.from({ length: 28 }, (_, i) => ({ date: addDays('2026-09-08', i), impressions: 10_000 + (i % 5) * 100, clicks: 500 + (i % 7) * 5, costMicros: (5000 + (i % 3) * 50) * M, conversions: 25 + (i % 4) })),
  { date: '2026-10-06', impressions: 10_200, clicks: 515, costMicros: 5050 * M, conversions: 26, ...today },
];

describe('robustZ', () => {
  it.each([
    [[1, 2, 3, 4, 100], 3, 0],
    [[10, 10, 10, 10], 10, 0],
    [[10, 10, 10, 10], 20, 20],
    [[0, 0, 0], 1, 1e9],
  ])('history %j, value %d → %d', (history, value, z) => {
    expect(robustZ(value, history)).toBeCloseTo(z, 5);
  });

  it('ignores a single spike in history', () => {
    expect(median([1, 2, 3, 4, 1000])).toBe(3);
    expect(Math.abs(robustZ(3, [1, 2, 3, 4, 1000]))).toBeLessThan(1);
  });
});

describe('detectMetricAnomalies', () => {
  it('finds nothing on a normal day', () => {
    expect(detectMetricAnomalies(series({}))).toEqual([]);
  });

  it.each<[string, Partial<DailyPoint>, string, 'up' | 'down']>([
    ['clicks triple', { clicks: 1500, costMicros: 15_000 * M, conversions: 78 }, 'clicks', 'up'],
    ['CPC jumps', { costMicros: 15_000 * M }, 'cpc', 'up'],
    ['conversion rate collapses', { conversions: 2 }, 'cvr', 'down'],
    ['CTR collapses', { impressions: 40_000 }, 'ctr', 'down'],
  ])('%s', (_, today, metric, direction) => {
    expect(detectMetricAnomalies(series(today))).toContainEqual(expect.objectContaining({ metric, direction, date: '2026-10-06' }));
  });

  it('needs enough history and volume', () => {
    expect(detectMetricAnomalies(series({ clicks: 1500 }).slice(-10))).toEqual([]);
    expect(detectMetricAnomalies(series({ clicks: 10, impressions: 50, costMicros: 5000 * M }), {}).find((a) => a.metric === 'cpc')).toBeUndefined();
  });
});

describe('segments and clicks vs sessions', () => {
  it('flags a segment against its own history', () => {
    const history = Array.from({ length: 20 }, (_, i) => 100 + (i % 3));
    expect(detectSegmentAnomalies('clicks', '2026-10-06', [{ key: 'TW', history, today: 101 }, { key: 'VN', history, today: 900 }])).toEqual([
      expect.objectContaining({ metric: 'clicks', details: { segment: 'VN' }, direction: 'up' }),
    ]);
  });

  const days = (clicks: number, sessions: number) => [
    ...Array.from({ length: 20 }, (_, i) => ({ date: addDays('2026-09-16', i), adsClicks: 500 + (i % 4) * 10, ga4Sessions: 450 + (i % 4) * 10 })),
    { date: '2026-10-06', adsClicks: clicks, ga4Sessions: sessions },
  ];

  it.each([
    ['clicks up, sessions flat', 1600, 460, true],
    ['clicks and sessions up together', 1600, 1500, false],
    ['nothing unusual', 520, 470, false],
  ])('%s', (_, clicks, sessions, flagged) => {
    expect(clicksWithoutSessions(days(clicks, sessions)) !== null).toBe(flagged);
  });

  it('needs GA4 data', () => {
    expect(clicksWithoutSessions(days(1600, 0).map((d) => ({ ...d, ga4Sessions: 0 })))).toBeNull();
  });
});
