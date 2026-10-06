import { describe, expect, it } from 'vitest';
import { describeAction, describeMonitor, monitorFormValues, monitorToForm, parseMonitorForm, type MonitorFormValues } from './monitor-rules';

const ACC = '0199b0c2-8f1e-7a3b-9c4d-123456789abc';
const v = (over: Partial<MonitorFormValues>): MonitorFormValues => ({ type: 'SpendPacing', accountId: ACC, campaignEntityId: '', fields: { pct: '150', minSpend: '' }, actionKind: 'pause', actionPct: '', cooldownHours: '6', enabled: true, ...over });

describe('monitor rule form', () => {
  it.each([
    [v({}), { spec: { type: 'SpendPacing', pct: 1.5, minSpendMicros: 0 }, action: { kind: 'pause' }, cooldownMinutes: 360 }],
    [v({ type: 'SpendNearCap', fields: { pct: '90' }, actionKind: 'reduce_budget', actionPct: '30' }), { spec: { type: 'SpendNearCap', pct: 0.9 }, action: { kind: 'reduce_budget', pct: 0.3 } }],
    [v({ type: 'CpaSpike', fields: { hours: '6', multiplier: '2', minConv: '3' }, actionKind: 'reduce_target', actionPct: '20', cooldownHours: '1.5' }), { spec: { type: 'CpaSpike', hours: 6, multiplier: 2, minConv: 3 }, action: { kind: 'reduce_target', pct: 0.2 }, cooldownMinutes: 90 }],
    [v({ type: 'RoasDrop', fields: { hours: '12', ratio: '50', minConv: '5' } }), { spec: { type: 'RoasDrop', hours: 12, ratio: 0.5, minConv: 5 } }],
  ])('parses %# and round-trips', (values, expected) => {
    const parsed = parseMonitorForm(values);
    expect(parsed).toMatchObject({ ok: true, value: { accountId: ACC, campaignEntityId: null, ...expected } });
    if (parsed.ok) expect(parseMonitorForm(monitorToForm(parsed.value))).toEqual(parsed);
  });

  it.each([
    [v({ fields: { pct: '90' } }), 'f_pct'],
    [v({ type: 'CpaSpike', fields: { hours: '0', multiplier: '2', minConv: '1' } }), 'f_hours'],
    [v({ actionKind: 'reduce_budget', actionPct: '95' }), 'actionPct'],
    [v({ cooldownHours: '200' }), 'cooldownHours'],
    [v({ accountId: '' }), 'accountId'],
  ])('reports errors %#', (values, key) => {
    const parsed = parseMonitorForm(values);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[key]).toBeTruthy();
  });

  it('reads only the fields of the chosen type and describes rules', () => {
    const f = new FormData();
    for (const [k, val] of Object.entries({ type: 'SpendNearCap', accountId: ACC, f_pct: '90', f_hours: 'x', actionKind: 'pause', cooldownHours: '6', enabled: 'on' })) f.set(k, val);
    expect(monitorFormValues(f)).toMatchObject({ type: 'SpendNearCap', fields: { pct: '90' }, enabled: true });
    expect(describeMonitor({ type: 'CpaSpike', hours: 6, multiplier: 2, minConv: 3 })).toBe('6h CPA > 目標 ×2（≥ 3 轉換）');
    expect(describeAction({ kind: 'reduce_budget', pct: 0.3 })).toBe('預算 −30%');
  });
});
