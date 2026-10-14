// Validator rules and tier thresholds settings (ADR-0008, ADR-0007, Requirements 5.1, 5.2, 18.4).
// Rule types are fixed in code; admins set parameters, scope and severity. Forms take money in
// account currency units and percentages, stored as micros and ratios.
// Labels, hints and descriptions are `rules.*` message keys; the UI translates them.
import { RuleSpecSchema, RULE_TYPES, type RuleSpec, type RuleType, type Severity, type TierThresholds } from '@arlo/core';
import type { Msg } from './msg';

export type FieldKind = 'money' | 'percent' | 'int' | 'metric';
export interface RuleField {
  name: string;
  /** `rules.field.*` message key. */
  label: 'dailyMax' | 'monthlyMax' | 'pct' | 'windowHours' | 'metric' | 'bidMin' | 'bidMax' | 'count';
  kind: FieldKind;
}

export const RULE_FIELDS: Record<RuleType, RuleField[]> = {
  DailyBudgetCap: [{ name: 'max', label: 'dailyMax', kind: 'money' }],
  MonthlySpendCap: [{ name: 'max', label: 'monthlyMax', kind: 'money' }],
  MaxChangePct: [
    { name: 'pct', label: 'pct', kind: 'percent' },
    { name: 'windowHours', label: 'windowHours', kind: 'int' },
  ],
  BidTargetRange: [
    { name: 'metric', label: 'metric', kind: 'metric' },
    { name: 'min', label: 'bidMin', kind: 'money' },
    { name: 'max', label: 'bidMax', kind: 'money' },
  ],
  MaxMutationsPerDay: [{ name: 'n', label: 'count', kind: 'int' }],
};

export type ScopeKind = 'org' | 'account' | 'campaign';

export interface RuleFormValues {
  type: RuleType;
  scopeKind: ScopeKind;
  accountId: string;
  campaignEntityId: string;
  severity: Severity;
  enabled: boolean;
  /** Raw field inputs by RULE_FIELDS name. */
  fields: Record<string, string>;
}

export interface RuleInput {
  scopeKind: ScopeKind;
  accountId: string | null;
  campaignEntityId: string | null;
  spec: RuleSpec;
  severity: Severity;
  enabled: boolean;
}

export type RuleFormErrors = Partial<Record<string, Msg>>;

const num = (s: string | undefined) => (s === undefined || s.trim() === '' ? NaN : Number(s.replace(/,/g, '')));
const UUID = /^[0-9a-f-]{36}$/i;

export function ruleFormValues(form: FormData): RuleFormValues {
  const type = String(form.get('type') ?? '') as RuleType;
  const fields: Record<string, string> = {};
  for (const f of RULE_FIELDS[type] ?? []) fields[f.name] = String(form.get(`f_${f.name}`) ?? '');
  return {
    type,
    scopeKind: String(form.get('scopeKind') ?? 'org') as ScopeKind,
    accountId: String(form.get('accountId') ?? ''),
    campaignEntityId: String(form.get('campaignEntityId') ?? ''),
    severity: form.get('severity') === 'WARN' ? 'WARN' : 'HARD_BLOCK',
    enabled: form.get('enabled') === 'on',
    fields,
  };
}

/** Form values → rule input, or errors keyed by field (`f_<name>` for spec fields). */
export function parseRuleForm(v: RuleFormValues): { ok: true; value: RuleInput } | { ok: false; errors: RuleFormErrors } {
  const errors: RuleFormErrors = {};
  if (!(RULE_TYPES as readonly string[]).includes(v.type)) return { ok: false, errors: { type: 'chooseRuleType' } };
  if (!['org', 'account', 'campaign'].includes(v.scopeKind)) errors.scopeKind = 'invalidScope';
  if (v.scopeKind !== 'org' && !UUID.test(v.accountId)) errors.accountId = 'chooseAccount';
  if (v.scopeKind === 'campaign' && !UUID.test(v.campaignEntityId)) errors.campaignEntityId = 'chooseCampaign';

  const f = v.fields;
  const money = (name: string) => Math.round(num(f[name]) * 1_000_000);
  let raw: unknown;
  switch (v.type) {
    case 'DailyBudgetCap':
    case 'MonthlySpendCap':
      raw = { type: v.type, maxMicros: money('max') };
      break;
    case 'MaxChangePct':
      raw = { type: v.type, pct: num(f.pct) / 100, windowHours: num(f.windowHours) };
      break;
    case 'BidTargetRange': {
      const metric = f.metric === 'troas' ? 'troas' : 'tcpa';
      // tCPA in micros; tROAS entered as a percentage, stored as a ratio.
      const value = (name: string) => (metric === 'tcpa' ? money(name) : num(f[name]) / 100);
      raw = { type: v.type, metric, min: value('min'), max: value('max') };
      break;
    }
    case 'MaxMutationsPerDay':
      raw = { type: v.type, n: num(f.n) };
      break;
  }
  const parsed = RuleSpecSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      const field = { maxMicros: 'max', pct: 'pct', windowHours: 'windowHours', min: 'min', max: 'max', n: 'n', metric: 'metric' }[key] ?? (key === '' ? 'min' : key);
      errors[`f_${field}`] ??= issue.message.includes('min must not exceed max') ? 'minExceedsMax' : 'invalidValue';
    }
  }
  if (Object.keys(errors).length || !parsed.success) return { ok: false, errors };
  return {
    ok: true,
    value: {
      scopeKind: v.scopeKind,
      accountId: v.scopeKind === 'org' ? null : v.accountId,
      campaignEntityId: v.scopeKind === 'campaign' ? v.campaignEntityId : null,
      spec: parsed.data,
      severity: v.severity,
      enabled: v.enabled,
    },
  };
}

const units = (micros: number) => String(Math.round(micros / 10_000) / 100);

/** Stored rule → form values for editing. */
export function ruleToFormValues(rule: RuleInput): RuleFormValues {
  const s = rule.spec;
  const fields: Record<string, string> =
    s.type === 'DailyBudgetCap' || s.type === 'MonthlySpendCap'
      ? { max: units(s.maxMicros) }
      : s.type === 'MaxChangePct'
        ? { pct: String(Math.round(s.pct * 10_000) / 100), windowHours: String(s.windowHours) }
        : s.type === 'BidTargetRange'
          ? { metric: s.metric, min: s.metric === 'tcpa' ? units(s.min) : String(s.min * 100), max: s.metric === 'tcpa' ? units(s.max) : String(s.max * 100) }
          : { n: String(s.n) };
  return {
    type: s.type,
    scopeKind: rule.scopeKind,
    accountId: rule.accountId ?? '',
    campaignEntityId: rule.campaignEntityId ?? '',
    severity: rule.severity,
    enabled: rule.enabled,
    fields,
  };
}

const fmt = (micros: number, currency?: string) => `${currency ? `${currency} ` : ''}${(micros / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export type RuleDescription =
  | { key: 'DailyBudgetCap' | 'MonthlySpendCap'; values: { amount: string } }
  | { key: 'MaxChangePct'; values: { hours: number; pct: number } }
  | { key: 'BidTargetRangeTcpa'; values: { min: string; max: string } }
  | { key: 'BidTargetRangeTroas'; values: { min: number; max: number } }
  | { key: 'MaxMutationsPerDay'; values: { n: number } };

/** One-line description as a `rules.describe.*` key and values, e.g. "Daily budget ≤ TWD 8,000". */
export function describeRule(spec: RuleSpec, currency?: string): RuleDescription {
  switch (spec.type) {
    case 'DailyBudgetCap':
    case 'MonthlySpendCap':
      return { key: spec.type, values: { amount: fmt(spec.maxMicros, currency) } };
    case 'MaxChangePct':
      return { key: 'MaxChangePct', values: { hours: spec.windowHours, pct: Math.round(spec.pct * 1000) / 10 } };
    case 'BidTargetRange':
      return spec.metric === 'tcpa'
        ? { key: 'BidTargetRangeTcpa', values: { min: fmt(spec.min, currency), max: fmt(spec.max, currency) } }
        : { key: 'BidTargetRangeTroas', values: { min: spec.min * 100, max: spec.max * 100 } };
    case 'MaxMutationsPerDay':
      return { key: 'MaxMutationsPerDay', values: { n: spec.n } };
  }
}

// --- tier thresholds ----------------------------------------------------------------------

export interface ThresholdFormValues {
  tier3Pct: string;
  tier3Amount: string;
  tier1MaxReducePct: string;
}

export function thresholdsToForm(t: TierThresholds): ThresholdFormValues {
  return {
    tier3Pct: String(Math.round(t.tier3Pct * 10_000) / 100),
    tier3Amount: t.tier3AmountMicros === null ? '' : units(t.tier3AmountMicros),
    tier1MaxReducePct: String(Math.round(t.tier1MaxReducePct * 10_000) / 100),
  };
}

export function parseThresholdForm(v: ThresholdFormValues): { ok: true; value: TierThresholds } | { ok: false; errors: Partial<Record<keyof ThresholdFormValues, Msg>> } {
  const errors: Partial<Record<keyof ThresholdFormValues, Msg>> = {};
  const tier3Pct = num(v.tier3Pct) / 100;
  const tier1 = num(v.tier1MaxReducePct) / 100;
  const amount = v.tier3Amount.trim() === '' ? null : Math.round(num(v.tier3Amount) * 1_000_000);
  if (!(tier3Pct > 0 && tier3Pct <= 10)) errors.tier3Pct = 'between0And1000Pct';
  if (!(tier1 >= 0 && tier1 <= 1)) errors.tier1MaxReducePct = 'between0And100Pct';
  if (amount !== null && !(amount > 0)) errors.tier3Amount = 'positiveOrEmpty';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { tier3Pct, tier3AmountMicros: amount, tier1MaxReducePct: tier1 } };
}
