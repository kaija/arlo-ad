// validate(changeSet, context, rules) → violations (ADR-0008, Requirements 5.1–5.6). Pure.
import type { ChangeSet, Violation } from '../changeset/types';
import { entityKey, type Op } from '../platform/types';
import { resolveRules, type RuleInstance, type RuleSpec } from './rules';

export interface CampaignContext {
  /** entities.id, used for campaign-scoped rules. */
  entityId: string;
  status: string | null;
  budgetMicros: number | null;
  /** Month-to-date spend in the account timezone. */
  mtdSpendMicros: number;
  bidStrategy?: string | null;
  bidTarget?: number | null;
}

export interface ValidationContext {
  /** Internal ad_accounts.id. */
  accountId: string;
  currency: string;
  /** Today in the account timezone, YYYY-MM-DD. */
  today: string;
  /** Account month-to-date spend; null when not synced yet. */
  mtdSpendMicros: number | null;
  /** Every campaign of the account, keyed by entityKey of its campaign ref. */
  campaigns: ReadonlyMap<string, CampaignContext>;
  /** Ops executed today for the account; null when unknown. */
  mutationsToday: number | null;
  mutationsTodayByCampaign?: ReadonlyMap<string, number>;
  /** A field's value `windowHours` ago (for MaxChangePct); undefined when unknown. */
  valueAt?: (key: string, field: string, windowHours: number) => number | undefined;
  /** Average daily spend over the last 7 / 14 days, for messages and agents. */
  avgDailySpend7dMicros?: number | null;
  avgDailySpend14dMicros?: number | null;
}

const money = (micros: number, currency: string) => `${currency} ${(micros / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

function daysLeft(today: string): number {
  const [y, m, d] = today.split('-').map(Number);
  const dim = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  // Today counts as remaining: its spend so far is in MTD, the rest is still to come (conservative).
  return dim - d! + 1;
}

type CampaignState = { status: string | null; budgetMicros: number | null };

/** Campaign states after applying the ChangeSet's budget and status ops. */
function applyToCampaigns(ops: readonly Op[], ctx: ValidationContext): Map<string, CampaignState> {
  const next = new Map<string, CampaignState>();
  for (const [key, c] of ctx.campaigns) next.set(key, { status: c.status, budgetMicros: c.budgetMicros });
  for (const op of ops) {
    if (op.target.kind !== 'campaign') continue;
    const key = entityKey(op.target);
    const state = next.get(key) ?? { status: null, budgetMicros: null };
    if (op.kind === 'set_budget' && typeof op.after === 'number') state.budgetMicros = op.after;
    if (op.kind === 'set_status' && typeof op.after === 'string') state.status = op.after;
    next.set(key, state);
  }
  return next;
}

const dailyBudget = (s: CampaignState) => (s.status === 'ENABLED' ? (s.budgetMicros ?? 0) : 0);

export function validate(cs: Pick<ChangeSet, 'ops' | 'accountId'>, ctx: ValidationContext, rules: readonly RuleInstance[]): Violation[] {
  const violations: Violation[] = [];
  const add = (rule: RuleInstance, message: string, opIndex?: number, details?: Violation['details']) =>
    violations.push({ ruleId: rule.id, ruleType: rule.spec.type, severity: rule.severity, opIndex, message, details });
  const missing = (rule: RuleInstance, what: string) =>
    violations.push({ ruleId: rule.id, ruleType: 'MISSING_CONTEXT', severity: 'WARN', message: `無法檢查 ${rule.spec.type}：尚未同步${what}` });

  const accountRules = resolveRules(rules, { accountId: cs.accountId });
  const campaignRules = (key: string) => {
    const entityId = ctx.campaigns.get(key)?.entityId;
    return resolveRules(rules, { accountId: cs.accountId, campaignEntityId: entityId });
  };
  const after = applyToCampaigns(cs.ops, ctx);
  const of = <T extends RuleSpec['type']>(list: RuleInstance[], type: T) => list.filter((r): r is RuleInstance & { spec: Extract<RuleSpec, { type: T }> } => r.spec.type === type);

  // --- per op: DailyBudgetCap, MaxChangePct, BidTargetRange -----------------------------
  cs.ops.forEach((op, i) => {
    if (op.target.kind !== 'campaign' || (op.kind !== 'set_budget' && op.kind !== 'set_bid_target')) return;
    const key = entityKey(op.target);
    const applicable = campaignRules(key);
    const afterValue = typeof op.after === 'number' ? op.after : null;
    const beforeValue = typeof op.before === 'number' ? op.before : null;

    if (op.kind === 'set_budget' && afterValue !== null) {
      for (const rule of of(applicable, 'DailyBudgetCap')) {
        // Lowering a budget is never blocked by a cap, even if it stays above it.
        if (afterValue > rule.spec.maxMicros && (beforeValue === null || afterValue > beforeValue)) {
          add(rule, `每日預算 ${money(afterValue, ctx.currency)} 超過上限 ${money(rule.spec.maxMicros, ctx.currency)}`, i, { afterMicros: afterValue, maxMicros: rule.spec.maxMicros });
        }
      }
    }

    if (op.kind === 'set_bid_target' && afterValue !== null) {
      const metric = op.field === 'target_roas' ? 'troas' : 'tcpa';
      for (const rule of of(applicable, 'BidTargetRange').filter((r) => r.spec.metric === metric)) {
        if (afterValue < rule.spec.min || afterValue > rule.spec.max) {
          const fmt = (v: number) => (metric === 'tcpa' ? money(v, ctx.currency) : v.toFixed(2));
          add(rule, `出價目標 ${fmt(afterValue)} 超出允許範圍 ${fmt(rule.spec.min)}–${fmt(rule.spec.max)}`, i, { after: afterValue, min: rule.spec.min, max: rule.spec.max });
        }
      }
    }

    if (afterValue !== null && op.field) {
      for (const rule of of(applicable, 'MaxChangePct')) {
        const baseline = ctx.valueAt?.(key, op.field, rule.spec.windowHours) ?? beforeValue;
        if (baseline === null || baseline === undefined) {
          missing(rule, `${rule.spec.windowHours} 小時前的值`);
          continue;
        }
        const change = baseline === 0 ? (afterValue === 0 ? 0 : Infinity) : Math.abs(afterValue - baseline) / Math.abs(baseline);
        if (change > rule.spec.pct + 1e-9) {
          add(rule, `${rule.spec.windowHours} 小時內累計變動 ${Number.isFinite(change) ? pct(change) : '∞'}，超過上限 ${pct(rule.spec.pct)}`, i, {
            baseline,
            after: afterValue,
            changePct: Number.isFinite(change) ? change : null,
            maxPct: rule.spec.pct,
          });
        }
      }
    }
  });

  // --- MonthlySpendCap: account totals, and campaigns with their own cap ----------------
  const remaining = daysLeft(ctx.today);
  for (const rule of of(accountRules, 'MonthlySpendCap')) {
    if (ctx.mtdSpendMicros === null) {
      missing(rule, '本月花費');
      continue;
    }
    const before = ctx.mtdSpendMicros + remaining * [...ctx.campaigns.values()].reduce((s, c) => s + dailyBudget(c), 0);
    const estimate = ctx.mtdSpendMicros + remaining * [...after.values()].reduce((s, c) => s + dailyBudget(c), 0);
    if (estimate > rule.spec.maxMicros && estimate > before) {
      add(rule, `預估本月花費 ${money(estimate, ctx.currency)} 超過帳戶上限 ${money(rule.spec.maxMicros, ctx.currency)}`, undefined, {
        estimateMicros: estimate,
        maxMicros: rule.spec.maxMicros,
        mtdMicros: ctx.mtdSpendMicros,
        remainingDays: remaining,
      });
    }
  }
  const touched = new Set(cs.ops.filter((o) => o.target.kind === 'campaign').map((o) => entityKey(o.target)));
  for (const key of touched) {
    const c = ctx.campaigns.get(key);
    const own = of(campaignRules(key), 'MonthlySpendCap').filter((r) => r.scope.kind === 'campaign');
    for (const rule of own) {
      if (!c) {
        missing(rule, ' campaign 資料');
        continue;
      }
      const before = c.mtdSpendMicros + remaining * dailyBudget(c);
      const estimate = c.mtdSpendMicros + remaining * dailyBudget(after.get(key)!);
      if (estimate > rule.spec.maxMicros && estimate > before) {
        add(rule, `預估本月 campaign 花費 ${money(estimate, ctx.currency)} 超過上限 ${money(rule.spec.maxMicros, ctx.currency)}`, cs.ops.findIndex((o) => entityKey(o.target) === key), {
          estimateMicros: estimate,
          maxMicros: rule.spec.maxMicros,
        });
      }
    }
  }

  // --- MaxMutationsPerDay ----------------------------------------------------------------
  for (const rule of of(accountRules, 'MaxMutationsPerDay')) {
    if (ctx.mutationsToday === null) {
      missing(rule, '今日變更次數');
      continue;
    }
    const total = ctx.mutationsToday + cs.ops.length;
    if (total > rule.spec.n) add(rule, `今日變更將達 ${total} 次，超過上限 ${rule.spec.n} 次`, undefined, { today: ctx.mutationsToday, adding: cs.ops.length, max: rule.spec.n });
  }
  for (const key of touched) {
    const own = of(campaignRules(key), 'MaxMutationsPerDay').filter((r) => r.scope.kind === 'campaign');
    for (const rule of own) {
      const entityId = ctx.campaigns.get(key)?.entityId;
      const today = entityId ? (ctx.mutationsTodayByCampaign?.get(entityId) ?? null) : null;
      if (today === null) {
        missing(rule, ' campaign 今日變更次數');
        continue;
      }
      const adding = cs.ops.filter((o) => entityKey(o.target) === key).length;
      if (today + adding > rule.spec.n) add(rule, `campaign 今日變更將達 ${today + adding} 次，超過上限 ${rule.spec.n} 次`, undefined, { today, adding, max: rule.spec.n });
    }
  }

  return violations;
}

export const hasHardBlock = (violations: readonly Violation[]) => violations.some((v) => v.severity === 'HARD_BLOCK');
