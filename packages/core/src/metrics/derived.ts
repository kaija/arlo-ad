// Ratios derived from summed metrics. Money stays in micros; ratios are null when undefined.

export interface MetricSums {
  costMicros: number;
  impressions: number;
  clicks: number;
  conversions: number;
  convValue: number;
}

export interface DerivedMetrics {
  ctr: number | null;
  cpcMicros: number | null;
  cpaMicros: number | null;
  /** Conversion value per unit cost (value and cost in the same currency). */
  roas: number | null;
  convRate: number | null;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

export function deriveMetrics(m: MetricSums): DerivedMetrics {
  return {
    ctr: ratio(m.clicks, m.impressions),
    cpcMicros: m.clicks > 0 ? Math.round(m.costMicros / m.clicks) : null,
    cpaMicros: m.conversions > 0 ? Math.round(m.costMicros / m.conversions) : null,
    roas: m.costMicros > 0 ? m.convValue / (m.costMicros / 1_000_000) : null,
    convRate: ratio(m.conversions, m.clicks),
  };
}

export const microsToUnits = (micros: number | null | undefined) => (micros === null || micros === undefined ? null : micros / 1_000_000);
