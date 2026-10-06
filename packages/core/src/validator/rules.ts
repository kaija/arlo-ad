// Validator rule types (ADR-0008, Requirement 5.1). Types are fixed in code; admins set the
// parameters, scope and severity. Money is in micros of the account currency.
import { z } from 'zod';
import type { Severity } from '../changeset/types';

export const RuleSpecSchema = z.discriminatedUnion('type', [
  /** Each campaign's daily budget ≤ max (account / org scope sets the default per campaign). */
  z.object({ type: z.literal('DailyBudgetCap'), maxMicros: z.number().int().positive() }),
  /** Estimated month spend (MTD + remaining days × new daily budgets) ≤ max (Requirement 5.5). */
  z.object({ type: z.literal('MonthlySpendCap'), maxMicros: z.number().int().positive() }),
  /** Cumulative change of a budget or bid target within the window ≤ pct (ratio, 0.3 = 30%). */
  z.object({ type: z.literal('MaxChangePct'), pct: z.number().positive().max(10), windowHours: z.number().int().min(1).max(24 * 31) }),
  /** Target CPA (micros) or target ROAS (ratio) must stay within [min, max]. */
  z.object({ type: z.literal('BidTargetRange'), metric: z.enum(['tcpa', 'troas']), min: z.number().nonnegative(), max: z.number().positive() }).refine((r) => r.min <= r.max, 'min must not exceed max'),
  /** Ops executed per account (or campaign) per day ≤ n. */
  z.object({ type: z.literal('MaxMutationsPerDay'), n: z.number().int().positive() }),
]);

export type RuleSpec = z.infer<typeof RuleSpecSchema>;
export type RuleType = RuleSpec['type'];
export const RULE_TYPES: readonly RuleType[] = ['DailyBudgetCap', 'MonthlySpendCap', 'MaxChangePct', 'BidTargetRange', 'MaxMutationsPerDay'];

export type RuleScope = { kind: 'org' } | { kind: 'account'; accountId: string } | { kind: 'campaign'; accountId: string; campaignEntityId: string };

export interface RuleInstance {
  id: string;
  scope: RuleScope;
  spec: RuleSpec;
  severity: Severity;
  enabled: boolean;
}

/** Rules sharing a key compete under scope override; different keys all apply. */
export function ruleKey(spec: RuleSpec): string {
  switch (spec.type) {
    case 'MaxChangePct':
      return `${spec.type}:${spec.windowHours}h`;
    case 'BidTargetRange':
      return `${spec.type}:${spec.metric}`;
    default:
      return spec.type;
  }
}

const SCOPE_RANK = { org: 0, account: 1, campaign: 2 } as const;

/**
 * The rules in force for an account, or for one campaign of it: per rule key the narrowest
 * enabled scope wins (campaign > account > org, Requirement 5.2).
 */
export function resolveRules(rules: readonly RuleInstance[], target: { accountId: string; campaignEntityId?: string }): RuleInstance[] {
  const applicable = rules.filter((r) => {
    if (!r.enabled) return false;
    if (r.scope.kind === 'org') return true;
    if (r.scope.accountId !== target.accountId) return false;
    return r.scope.kind === 'account' || r.scope.campaignEntityId === target.campaignEntityId;
  });
  const best = new Map<string, RuleInstance>();
  for (const r of applicable) {
    const key = ruleKey(r.spec);
    const current = best.get(key);
    if (!current || SCOPE_RANK[r.scope.kind] > SCOPE_RANK[current.scope.kind]) best.set(key, r);
  }
  return [...best.values()];
}
