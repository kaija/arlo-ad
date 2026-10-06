// Anomaly detection (ADR-0021, Requirement 16.4): rolling median + MAD (robust z-score), which
// one spike in the history cannot drag the way a mean and standard deviation would. Pure.

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * (value − median) / (1.4826 × MAD). A flat history has MAD 0; the scale then falls back to 5%
 * of the median (or 1e-9), so a real departure still scores high instead of dividing by zero.
 */
export function robustZ(value: number, history: readonly number[]): number {
  const m = median(history);
  const mad = median(history.map((h) => Math.abs(h - m)));
  const scale = Math.max(1.4826 * mad, Math.abs(m) * 0.05, 1e-9);
  return (value - m) / scale;
}

export const ANOMALY_METRICS = ['clicks', 'ctr', 'cpc', 'cvr', 'cost', 'conversions'] as const;
export type AnomalyMetric = (typeof ANOMALY_METRICS)[number] | 'clicks_vs_sessions';

export interface DailyPoint {
  date: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
}

export interface Anomaly {
  date: string;
  metric: AnomalyMetric;
  value: number;
  baseline: number;
  z: number;
  direction: 'up' | 'down';
  /** Free-form context, e.g. the segment key or the sessions series. */
  details?: Record<string, number | string | null>;
}

export interface DetectOptions {
  /** History days before the evaluated day (default 28). */
  window?: number;
  /** Fewer history days than this → nothing is evaluated (default 14). */
  minHistory?: number;
  /** |z| at or above this is anomalous (default 3.5). */
  threshold?: number;
  /** Ratios need this many denominator events on the day to be judged. */
  minClicks?: number;
  minImpressions?: number;
}

type Ratio = (p: DailyPoint) => { value: number | null; volumeOk: (o: Required<DetectOptions>) => boolean };

const METRIC: Record<(typeof ANOMALY_METRICS)[number], Ratio> = {
  clicks: (p) => ({ value: p.clicks, volumeOk: (o) => p.impressions >= o.minImpressions || p.clicks >= o.minClicks }),
  cost: (p) => ({ value: p.costMicros, volumeOk: () => true }),
  conversions: (p) => ({ value: p.conversions, volumeOk: (o) => p.clicks >= o.minClicks }),
  ctr: (p) => ({ value: p.impressions > 0 ? p.clicks / p.impressions : null, volumeOk: (o) => p.impressions >= o.minImpressions }),
  cpc: (p) => ({ value: p.clicks > 0 ? p.costMicros / p.clicks : null, volumeOk: (o) => p.clicks >= o.minClicks }),
  cvr: (p) => ({ value: p.clicks > 0 ? p.conversions / p.clicks : null, volumeOk: (o) => p.clicks >= o.minClicks }),
};

const defaults = (o: DetectOptions): Required<DetectOptions> => ({ window: 28, minHistory: 14, threshold: 3.5, minClicks: 30, minImpressions: 300, ...o });

/** Anomalies on the last day of `series` against the `window` days before it. */
export function detectMetricAnomalies(series: readonly DailyPoint[], opts: DetectOptions = {}): Anomaly[] {
  const o = defaults(opts);
  const days = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const today = days.at(-1);
  const history = days.slice(-(o.window + 1), -1);
  if (!today || history.length < o.minHistory) return [];
  const out: Anomaly[] = [];
  for (const metric of ANOMALY_METRICS) {
    const t = METRIC[metric](today);
    if (t.value === null || !t.volumeOk(o)) continue;
    const past = history.map((p) => METRIC[metric](p).value).filter((v): v is number => v !== null);
    if (past.length < o.minHistory) continue;
    const z = robustZ(t.value, past);
    if (Math.abs(z) >= o.threshold) out.push({ date: today.date, metric, value: t.value, baseline: median(past), z, direction: z > 0 ? 'up' : 'down' });
  }
  return out;
}

export interface SegmentSeries {
  /** e.g. a country code or a placement. */
  key: string;
  history: readonly number[];
  today: number;
}

/** Segments whose value today departs from their own history (geo, placement; Requirement 16.4). */
export function detectSegmentAnomalies(metric: AnomalyMetric, date: string, segments: readonly SegmentSeries[], opts: DetectOptions = {}): Anomaly[] {
  const o = defaults(opts);
  return segments.flatMap((s) => {
    if (s.history.length < o.minHistory) return [];
    const z = robustZ(s.today, s.history);
    return Math.abs(z) >= o.threshold ? [{ date, metric, value: s.today, baseline: median(s.history), z, direction: z > 0 ? ('up' as const) : ('down' as const), details: { segment: s.key } }] : [];
  });
}

export interface ClicksSessionsDay {
  date: string;
  adsClicks: number;
  ga4Sessions: number;
}

/**
 * Clicks jump while GA4 sessions stay flat: invalid traffic, broken landing pages or lost
 * tagging (Requirement 16.4). Needs a linked GA4 property.
 */
export function clicksWithoutSessions(series: readonly ClicksSessionsDay[], opts: DetectOptions & { flatZ?: number } = {}): Anomaly | null {
  const o = defaults(opts);
  const days = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const today = days.at(-1);
  const history = days.slice(-(o.window + 1), -1);
  if (!today || history.length < o.minHistory || today.adsClicks < o.minClicks) return null;
  if (history.every((d) => d.ga4Sessions === 0)) return null;
  const clicksZ = robustZ(today.adsClicks, history.map((d) => d.adsClicks));
  const sessionsZ = robustZ(today.ga4Sessions, history.map((d) => d.ga4Sessions));
  if (clicksZ < o.threshold || sessionsZ > (opts.flatZ ?? 1)) return null;
  return {
    date: today.date,
    metric: 'clicks_vs_sessions',
    value: today.adsClicks,
    baseline: median(history.map((d) => d.adsClicks)),
    z: clicksZ,
    direction: 'up',
    details: { sessions: today.ga4Sessions, sessionsBaseline: median(history.map((d) => d.ga4Sessions)), sessionsZ: Math.round(sessionsZ * 100) / 100 },
  };
}
