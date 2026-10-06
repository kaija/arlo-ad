// runGuard (ADR-0023, Requirement 19.3): non-critical LLM work stops for the rest of the day once
// today's estimated spend reaches the budget; admins are told once per day.
import { dateInTimeZone, llmBudgetDecision, zonedToInstant, type BudgetDecision } from '@arlo/core';
import { getSetting, llmCostSince, setSettingOnce, type Db } from '@arlo/db';

export interface RunGuardOptions {
  db: Db;
  /** DAILY_LLM_BUDGET_USD; the `daily_llm_budget_usd` setting overrides it. */
  defaultBudgetUsd: number;
  critical: boolean;
  now: () => Date;
  /** Day boundary for "today" (Requirement 19.3). */
  timeZone?: string;
  /** Called once per day, the first time the budget stops a run. */
  notify?: (decision: Extract<BudgetDecision, { run: false }>) => Promise<void>;
}

export async function runGuard(opts: RunGuardOptions): Promise<BudgetDecision> {
  const tz = opts.timeZone ?? 'Asia/Taipei';
  const today = dateInTimeZone(opts.now(), tz);
  const budget = (await getSetting<number>(opts.db, 'daily_llm_budget_usd')) ?? opts.defaultBudgetUsd;
  const spent = await llmCostSince(opts.db, zonedToInstant(today, tz));
  const decision = llmBudgetDecision({ spentUsd: spent, budgetUsd: Number(budget), critical: opts.critical });
  if (!decision.run && opts.notify && (await setSettingOnce(opts.db, 'llm_budget_alerted_on', today))) {
    await opts.notify(decision);
  }
  return decision;
}
