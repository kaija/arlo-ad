// Daily spend, conversions and CPA as stacked sparklines with numbered change markers on the
// shared time axis (Requirement 18.2). Plain SVG, rendered on the server.
import { formatMoney, formatNumber } from '@arlo/core';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

export interface TrendChartPoint {
  date: string;
  costMicros: number;
  conversions: number;
  cpaMicros: number | null;
}

export interface TrendChartMarker {
  date: string;
  label: string;
  actor: string | null;
  /** A changeset since undone. */
  reverted?: boolean;
  kind: 'change_event' | 'changeset';
  changesetId?: string;
}

const W = 1000;
const H = 84;

function paths(values: (number | null)[]) {
  // Days without a value (CPA with no conversions) hold the previous level.
  const first = values.find((v) => v !== null) ?? 0;
  let last = first;
  const filled = values.map((v) => (last = v ?? last));
  const min = Math.min(...filled);
  const range = Math.max(...filled) - min || 1;
  const step = filled.length > 1 ? W / (filled.length - 1) : 0;
  const line = 'M' + filled.map((v, i) => `${(i * step).toFixed(1)},${(78 - ((v - min) / range) * 66).toFixed(1)}`).join(' L');
  return { line, area: `${line} L${W},${H} L0,${H} Z` };
}

const md = (date: string) => date.slice(5).replace('-', '/');

export function TrendChart({ points, markers, currency }: { points: TrendChartPoint[]; markers: TrendChartMarker[]; currency: string }) {
  const t = useTranslations('trend');
  if (points.length === 0) return <p className="py-3 text-sm text-muted">{t('noData')}</p>;
  const cost = points.reduce((s, p) => s + p.costMicros, 0);
  const conversions = points.reduce((s, p) => s + p.conversions, 0);
  const rows = [
    { label: t('dailySpend'), total: formatMoney(cost, currency), ...paths(points.map((p) => p.costMicros)) },
    { label: t('conversions'), total: formatNumber(conversions, conversions % 1 ? 1 : 0), ...paths(points.map((p) => p.conversions)) },
    { label: 'CPA', total: conversions > 0 ? formatMoney(cost / conversions, currency) : '—', ...paths(points.map((p) => p.cpaMicros)) },
  ];

  // One numbered marker per day that had changes.
  const index = new Map(points.map((p, i) => [p.date, i]));
  const days = [...new Set(markers.map((m) => m.date))].filter((d) => index.has(d)).sort();
  const number = new Map(days.map((d, i) => [d, i + 1]));
  const x = (date: string) => (points.length > 1 ? (index.get(date)! / (points.length - 1)) * 100 : 50);
  const recent = markers.filter((m) => number.has(m.date)).slice(-8).reverse();
  const tickCount = Math.min(5, points.length);
  const ticks = Array.from({ length: tickCount }, (_, i) => points[Math.round((i * (points.length - 1)) / Math.max(1, tickCount - 1))]!.date);

  return (
    <>
      <div className="relative flex flex-col gap-1.5 pl-[120px]">
        {rows.map((r) => (
          <div key={r.label} className="relative h-[84px] border-b border-border">
            <div className="absolute top-2.5 -left-[120px] flex w-[108px] flex-col gap-0.5">
              <span className="text-xs text-faint">{r.label}</span>
              <span className="text-ui font-semibold">{r.total}</span>
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[84px] w-full overflow-visible">
              <path d={r.area} fill="rgba(88,86,214,0.08)" />
              <path d={r.line} fill="none" stroke="#5856D6" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </svg>
          </div>
        ))}
        <div className="pointer-events-none absolute top-0 right-0 bottom-0 left-[120px]">
          {days.map((d) => (
            <div key={d} className="absolute -top-1.5 bottom-0 border-l border-dashed border-accent/45" style={{ left: `${x(d).toFixed(2)}%` }}>
              <span className="absolute -top-1 -left-[9px] flex h-[18px] w-[18px] items-center justify-center rounded-pill bg-accent text-[0.625rem] font-bold text-white">{number.get(d)}</span>
            </div>
          ))}
        </div>
        <div className="flex justify-between font-mono text-xs text-faint">
          {ticks.map((t) => (
            <span key={t}>{md(t)}</span>
          ))}
        </div>
      </div>

      <div className="flex flex-col">
        <span className="eyebrow pb-2">{t('recentEvents')}</span>
        {recent.length === 0 ? <p className="py-3 text-sm text-muted">{t('noEvents')}</p> : null}
        {recent.map((m, i) => (
          <div key={i} className="grid grid-cols-[28px_64px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-2.5 text-sm">
            <span className="flex h-5 w-5 items-center justify-center rounded-pill bg-accent-light text-[0.6875rem] font-bold text-accent">{number.get(m.date)}</span>
            <span className="font-mono text-meta text-muted">{md(m.date)}</span>
            <span className="min-w-0">
              {m.label}{' '}
              {m.changesetId ? (
                <Link href={`/changesets/${m.changesetId}`} className="link font-mono text-meta">
                  {m.changesetId.slice(-8)} →
                </Link>
              ) : null}
            </span>
            <span className="text-right text-meta text-faint">{m.actor ?? ''}{m.reverted ? ` ${t('reverted')}` : ''}</span>
          </div>
        ))}
      </div>
    </>
  );
}
