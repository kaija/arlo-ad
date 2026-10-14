// Monitor rule settings (ADR-0017, Requirement 18.4). Percentages in the form, ratios stored.
// Labels, hints and descriptions are `monitor.*` message keys; the UI translates them.
import { MonitorActionSchema, MonitorRuleSpecSchema, MONITOR_RULE_TYPES, type MonitorAction, type MonitorRuleSpec, type MonitorRuleType } from '@arlo/core';
import type { Msg } from './msg';

type FieldKey = 'pacingPct' | 'minSpend' | 'capPct' | 'hours' | 'multiplier' | 'minConv' | 'ratio';
type HintKey = 'pacingPctHint' | 'minSpendHint' | 'capPctHint' | 'multiplierHint' | 'ratioHint';

/** Inputs per rule type; `label` and `hint` are `monitor.field.*` keys. */
export const MONITOR_FIELDS: Record<MonitorRuleType, { name: string; label: FieldKey; hint?: HintKey }[]> = {
  SpendPacing: [
    { name: 'pct', label: 'pacingPct', hint: 'pacingPctHint' },
    { name: 'minSpend', label: 'minSpend', hint: 'minSpendHint' },
  ],
  SpendNearCap: [{ name: 'pct', label: 'capPct', hint: 'capPctHint' }],
  CpaSpike: [
    { name: 'hours', label: 'hours' },
    { name: 'multiplier', label: 'multiplier', hint: 'multiplierHint' },
    { name: 'minConv', label: 'minConv' },
  ],
  RoasDrop: [
    { name: 'hours', label: 'hours' },
    { name: 'ratio', label: 'ratio', hint: 'ratioHint' },
    { name: 'minConv', label: 'minConv' },
  ],
};

export const ACTION_KINDS = ['pause', 'reduce_budget', 'reduce_target'] as const satisfies readonly MonitorAction['kind'][];

export interface MonitorFormValues {
  type: MonitorRuleType;
  accountId: string;
  campaignEntityId: string;
  fields: Record<string, string>;
  actionKind: MonitorAction['kind'];
  actionPct: string;
  cooldownHours: string;
  enabled: boolean;
}

export type MonitorFormErrors = Partial<Record<string, Msg>>;

const num = (s: string | undefined) => (s === undefined || s.trim() === '' ? NaN : Number(s.replace(/,/g, '')));
const UUID = /^[0-9a-f-]{36}$/i;

export function monitorFormValues(form: FormData): MonitorFormValues {
  const type = String(form.get('type') ?? '') as MonitorRuleType;
  const fields: Record<string, string> = {};
  for (const f of MONITOR_FIELDS[type] ?? []) fields[f.name] = String(form.get(`f_${f.name}`) ?? '');
  return {
    type,
    accountId: String(form.get('accountId') ?? ''),
    campaignEntityId: String(form.get('campaignEntityId') ?? ''),
    fields,
    actionKind: String(form.get('actionKind') ?? 'pause') as MonitorAction['kind'],
    actionPct: String(form.get('actionPct') ?? ''),
    cooldownHours: String(form.get('cooldownHours') ?? ''),
    enabled: form.get('enabled') === 'on',
  };
}

export interface MonitorRuleValue {
  accountId: string;
  campaignEntityId: string | null;
  spec: MonitorRuleSpec;
  action: MonitorAction;
  cooldownMinutes: number;
  enabled: boolean;
}

export function parseMonitorForm(v: MonitorFormValues): { ok: true; value: MonitorRuleValue } | { ok: false; errors: MonitorFormErrors } {
  const errors: MonitorFormErrors = {};
  if (!(MONITOR_RULE_TYPES as readonly string[]).includes(v.type)) return { ok: false, errors: { type: 'chooseRuleType' } };
  if (!UUID.test(v.accountId)) errors.accountId = 'chooseAccount';
  if (v.campaignEntityId && !UUID.test(v.campaignEntityId)) errors.campaignEntityId = 'invalidCampaign';
  const f = v.fields;
  const raw =
    v.type === 'SpendPacing'
      ? { type: v.type, pct: num(f.pct) / 100, minSpendMicros: Number.isNaN(num(f.minSpend)) ? 0 : Math.round(num(f.minSpend) * 1_000_000) }
      : v.type === 'SpendNearCap'
        ? { type: v.type, pct: num(f.pct) / 100 }
        : v.type === 'CpaSpike'
          ? { type: v.type, hours: num(f.hours), multiplier: num(f.multiplier), minConv: num(f.minConv) }
          : { type: v.type, hours: num(f.hours), ratio: num(f.ratio) / 100, minConv: num(f.minConv) };
  const spec = MonitorRuleSpecSchema.safeParse(raw);
  if (!spec.success) for (const issue of spec.error.issues) errors[`f_${{ minSpendMicros: 'minSpend' }[String(issue.path[0])] ?? String(issue.path[0])}`] ??= 'invalidValue';
  const action = MonitorActionSchema.safeParse(v.actionKind === 'pause' ? { kind: 'pause' } : { kind: v.actionKind, pct: num(v.actionPct) / 100 });
  if (!action.success) errors.actionPct = 'actionPctRange';
  const cooldown = num(v.cooldownHours);
  if (!(cooldown >= 0 && cooldown <= 168)) errors.cooldownHours = 'cooldownRange';
  if (Object.keys(errors).length || !spec.success || !action.success) return { ok: false, errors };
  return { ok: true, value: { accountId: v.accountId, campaignEntityId: v.campaignEntityId || null, spec: spec.data, action: action.data, cooldownMinutes: Math.round(cooldown * 60), enabled: v.enabled } };
}

const pct = (r: number) => String(Math.round(r * 10_000) / 100);

export function monitorToForm(r: MonitorRuleValue): MonitorFormValues {
  const s = r.spec;
  const fields: Record<string, string> =
    s.type === 'SpendPacing'
      ? { pct: pct(s.pct), minSpend: String(s.minSpendMicros / 1_000_000) }
      : s.type === 'SpendNearCap'
        ? { pct: pct(s.pct) }
        : s.type === 'CpaSpike'
          ? { hours: String(s.hours), multiplier: String(s.multiplier), minConv: String(s.minConv) }
          : { hours: String(s.hours), ratio: pct(s.ratio), minConv: String(s.minConv) };
  return {
    type: s.type,
    accountId: r.accountId,
    campaignEntityId: r.campaignEntityId ?? '',
    fields,
    actionKind: r.action.kind,
    actionPct: r.action.kind === 'pause' ? '' : pct(r.action.pct),
    cooldownHours: String(r.cooldownMinutes / 60),
    enabled: r.enabled,
  };
}

/** A `monitor.describe.*` key with its values. */
export interface MonitorDescription {
  key: MonitorRuleType | MonitorAction['kind'];
  values: Record<string, string | number>;
}

export function describeMonitor(spec: MonitorRuleSpec): MonitorDescription {
  switch (spec.type) {
    case 'SpendPacing':
    case 'SpendNearCap':
      return { key: spec.type, values: { pct: pct(spec.pct) } };
    case 'CpaSpike':
      return { key: 'CpaSpike', values: { hours: spec.hours, multiplier: spec.multiplier, minConv: spec.minConv } };
    case 'RoasDrop':
      return { key: 'RoasDrop', values: { hours: spec.hours, pct: pct(spec.ratio), minConv: spec.minConv } };
  }
}

export function describeAction(a: MonitorAction): MonitorDescription {
  return a.kind === 'pause' ? { key: 'pause', values: {} } : { key: a.kind, values: { pct: pct(a.pct) } };
}
