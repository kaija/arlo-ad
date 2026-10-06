// Monitor rule settings (ADR-0017, Requirement 18.4). Percentages in the form, ratios stored.
import { MonitorActionSchema, MonitorRuleSpecSchema, MONITOR_RULE_TYPES, type MonitorAction, type MonitorRuleSpec, type MonitorRuleType } from '@arlo/core';

export const MONITOR_TYPE_LABEL: Record<MonitorRuleType, string> = {
  SpendPacing: '當日花費超速',
  SpendNearCap: '月花費接近上限',
  CpaSpike: 'CPA 暴增',
  RoasDrop: 'ROAS 暴跌',
};

export const MONITOR_TYPE_HINT: Record<MonitorRuleType, string> = {
  SpendPacing: '今日花費 ÷（每日預算 × 已過時間比例）超過門檻時觸發。',
  SpendNearCap: '本月花費達 MonthlySpendCap 的比例時觸發（需先設定月花費上限規則）。',
  CpaSpike: 'N 小時內 CPA 超過目標 CPA 的 K 倍、且轉換數 ≥ M 時觸發。',
  RoasDrop: 'N 小時內 ROAS 低於目標 ROAS 的比例、且轉換數 ≥ M 時觸發。',
};

export const MONITOR_FIELDS: Record<MonitorRuleType, { name: string; label: string; hint?: string }[]> = {
  SpendPacing: [
    { name: 'pct', label: '超速門檻（%）', hint: '例如 150 = 花費速度為預期的 1.5 倍' },
    { name: 'minSpend', label: '最低花費（帳戶幣別）', hint: '避免清晨少量花費誤觸發' },
  ],
  SpendNearCap: [{ name: 'pct', label: '達上限比例（%）', hint: '例如 90' }],
  CpaSpike: [
    { name: 'hours', label: '時間窗（小時）' },
    { name: 'multiplier', label: '倍數 K', hint: '例如 2 = 目標的 2 倍' },
    { name: 'minConv', label: '最少轉換數 M' },
  ],
  RoasDrop: [
    { name: 'hours', label: '時間窗（小時）' },
    { name: 'ratio', label: '低於目標的比例（%）', hint: '例如 50 = ROAS 低於目標一半' },
    { name: 'minConv', label: '最少轉換數 M' },
  ],
};

export const ACTION_LABEL = { pause: '暫停 campaign', reduce_budget: '降低每日預算', reduce_target: '收緊出價目標（降 tCPA / 升 tROAS）' } as const;

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

export type MonitorFormErrors = Partial<Record<string, string>>;

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
  if (!(MONITOR_RULE_TYPES as readonly string[]).includes(v.type)) return { ok: false, errors: { type: '請選擇規則類型' } };
  if (!UUID.test(v.accountId)) errors.accountId = '請選擇帳戶';
  if (v.campaignEntityId && !UUID.test(v.campaignEntityId)) errors.campaignEntityId = 'campaign 不正確';
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
  if (!spec.success) for (const issue of spec.error.issues) errors[`f_${{ minSpendMicros: 'minSpend' }[String(issue.path[0])] ?? String(issue.path[0])}`] ??= '數值不正確';
  const action = MonitorActionSchema.safeParse(v.actionKind === 'pause' ? { kind: 'pause' } : { kind: v.actionKind, pct: num(v.actionPct) / 100 });
  if (!action.success) errors.actionPct = '幅度需介於 1–90%';
  const cooldown = num(v.cooldownHours);
  if (!(cooldown >= 0 && cooldown <= 168)) errors.cooldownHours = '冷卻需介於 0–168 小時';
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

export function describeMonitor(spec: MonitorRuleSpec): string {
  switch (spec.type) {
    case 'SpendPacing':
      return `花費速度 > ${pct(spec.pct)}%`;
    case 'SpendNearCap':
      return `月花費 ≥ 上限的 ${pct(spec.pct)}%`;
    case 'CpaSpike':
      return `${spec.hours}h CPA > 目標 ×${spec.multiplier}（≥ ${spec.minConv} 轉換）`;
    case 'RoasDrop':
      return `${spec.hours}h ROAS < 目標的 ${pct(spec.ratio)}%（≥ ${spec.minConv} 轉換）`;
  }
}

export function describeAction(a: MonitorAction): string {
  return a.kind === 'pause' ? '暫停' : a.kind === 'reduce_budget' ? `預算 −${pct(a.pct)}%` : `出價目標收緊 ${pct(a.pct)}%`;
}
