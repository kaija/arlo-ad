'use client';

// Daily spend and conversions with change markers on the time axis (Requirement 18.2).
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export interface TrendChartPoint {
  date: string;
  cost: number;
  conversions: number;
  cpa: number | null;
}

export interface TrendChartMarker {
  date: string;
  label: string;
  actor: string | null;
  kind: 'change_event' | 'changeset';
}

export function TrendChart({ points, markers, currency }: { points: TrendChartPoint[]; markers: TrendChartMarker[]; currency: string }) {
  const byDate = new Map<string, TrendChartMarker[]>();
  for (const m of markers) byDate.set(m.date, [...(byDate.get(m.date) ?? []), m]);
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <ComposedChart data={points} margin={{ top: 16, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} />
          <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} fontSize={12} />
          <YAxis yAxisId="cost" fontSize={12} width={64} />
          <YAxis yAxisId="conv" orientation="right" fontSize={12} width={40} />
          <Tooltip
            formatter={(value, name) => (name === `花費 (${currency})` ? Number(value).toLocaleString() : value)}
            labelFormatter={(d) => {
              const ms = byDate.get(String(d)) ?? [];
              return ms.length ? `${d} · ${ms.map((m) => `${m.label}${m.actor ? ` (${m.actor})` : ''}`).join('；')}` : String(d);
            }}
          />
          <Legend />
          <Bar yAxisId="cost" dataKey="cost" name={`花費 (${currency})`} fill="#6366f1" fillOpacity={0.6} />
          <Line yAxisId="conv" dataKey="conversions" name="轉換" stroke="#10b981" strokeWidth={2} dot={false} />
          {[...byDate.entries()].map(([date, ms]) => (
            <ReferenceLine
              key={date}
              x={date}
              yAxisId="cost"
              stroke={ms.some((m) => m.kind === 'changeset') ? '#f59e0b' : '#ef4444'}
              strokeDasharray="4 2"
              label={{ value: ms.length > 1 ? `▲${ms.length}` : '▲', position: 'top', fontSize: 11, fill: '#ef4444' }}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
