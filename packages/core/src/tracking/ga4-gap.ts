// GA4 vs Google Ads conversion gap (ADR-0021, Requirement 16.3). The two never match exactly
// (attribution, consent, key event definitions), so the alert is on the ratio shifting against
// its own recent baseline, not on the gap itself.

export interface GapDay {
  date: string;
  adsConversions: number;
  ga4Conversions: number;
}

export interface GapOptions {
  /** Days in the baseline window before the recent window (Requirement 16.3: 14). */
  baselineDays?: number;
  recentDays?: number;
  /** Relative shift of the ratio that alerts (0.3 = 30%). */
  threshold?: number;
  /** Ads conversions the baseline needs before a ratio means anything. */
  minConversions?: number;
}

export interface GapResult {
  baselineRatio: number | null;
  recentRatio: number | null;
  /** (recent − baseline) / baseline; null when not computable. */
  shift: number | null;
  alert: boolean;
  reason: string;
}

const ratio = (days: readonly GapDay[]) => {
  const ads = days.reduce((s, d) => s + d.adsConversions, 0);
  const ga4 = days.reduce((s, d) => s + d.ga4Conversions, 0);
  return { ads, ga4, ratio: ads > 0 ? ga4 / ads : null };
};

export function ga4Gap(series: readonly GapDay[], opts: GapOptions = {}): GapResult {
  const baselineDays = opts.baselineDays ?? 14;
  const recentDays = opts.recentDays ?? 3;
  const threshold = opts.threshold ?? 0.3;
  const minConversions = opts.minConversions ?? 10;
  const days = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const recent = days.slice(-recentDays);
  const baseline = days.slice(-(recentDays + baselineDays), -recentDays);
  const b = ratio(baseline);
  const r = ratio(recent);
  if (baseline.length < Math.ceil(baselineDays / 2) || b.ads < minConversions || b.ratio === null) {
    return { baselineRatio: b.ratio, recentRatio: r.ratio, shift: null, alert: false, reason: '基準期間資料不足' };
  }
  if (r.ads === 0 && r.ga4 === 0) {
    // Both silent: tracking health catches dead Ads tracking; nothing to compare here.
    return { baselineRatio: b.ratio, recentRatio: null, shift: null, alert: false, reason: '近期兩邊都沒有轉換' };
  }
  const recentRatio = r.ads > 0 ? r.ga4 / r.ads : Infinity;
  const shift = (recentRatio - b.ratio) / b.ratio;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const alert = !Number.isFinite(shift) || Math.abs(shift) > threshold;
  return {
    baselineRatio: b.ratio,
    recentRatio: Number.isFinite(recentRatio) ? recentRatio : null,
    shift: Number.isFinite(shift) ? shift : null,
    alert,
    reason: alert
      ? Number.isFinite(shift)
        ? `GA4/Ads 轉換比由 ${pct(b.ratio)} 變為 ${pct(recentRatio)}（偏移 ${shift > 0 ? '+' : ''}${pct(shift)}）`
        : `Ads 近期沒有轉換，但 GA4 有 ${r.ga4} 次`
      : `GA4/Ads 轉換比 ${pct(recentRatio)}，與基準 ${pct(b.ratio)} 相近`,
  };
}
