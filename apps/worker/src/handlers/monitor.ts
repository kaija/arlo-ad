// Monitor job (ADR-0017, Requirements 12.1–12.4): runs after each snapshot sync, without an LLM.
// A triggered rule outside its cooldown becomes a Tier 1 ChangeSet (circuit_breaker or
// bid_auto_reduce) for the Executor, which applies the automation mode (shadow by default).
import type { Logger } from '@arlo/config/logger';
import {
  dateInTimeZone,
  evaluateMonitor,
  formatMoney,
  inCooldown,
  monitorActionOps,
  resolveRules,
  wallTime,
  type AutomationFeature,
  type MonitorAction,
  type MonitorEvaluation,
  type MonitorRuleSpec,
  type MonitorWindow,
  type Op,
} from '@arlo/core';
import {
  dailySpend,
  getAdAccount,
  getAutomationMode,
  hourlyTotals,
  lastFiring,
  listCampaigns,
  listMonitorRules,
  loadEntityIds,
  loadRules,
  recordFiring,
  spendOn,
  type AdAccount,
  type CampaignRow,
  type Db,
  type HourSlot,
  type MonitorRule,
  type NewChangeSet,
} from '@arlo/db';
import { defineJob, Jobs, type JobData, type JobSpec } from '@arlo/queue';

export interface MonitorDeps {
  db: Db;
  logger: Logger;
  now: () => Date;
  /** Stores a ChangeSet and queues changeset.process. */
  propose?: (input: NewChangeSet) => Promise<{ id: string }>;
  enqueue: <J extends JobSpec>(spec: J, data: JobData<J>) => Promise<string>;
}

export interface Firing {
  ruleId: string;
  entityId: string;
  changesetId: string | null;
  evidence: MonitorEvaluation['evidence'];
}

const RULE_LABEL: Record<MonitorRuleSpec['type'], (e: MonitorEvaluation['evidence'], currency: string) => string> = {
  SpendPacing: (e) => `今日花費達進度的 ${Math.round(Number(e.pacing) * 100)}%`,
  SpendNearCap: (e) => `本月花費達上限的 ${Math.round(Number(e.share) * 100)}%`,
  CpaSpike: (e, c) => `${e.hours} 小時 CPA ${formatMoney(Number(e.cpaMicros), c)} 為目標 ${Number(e.ratio).toFixed(1)} 倍`,
  RoasDrop: (e) => `${e.hours} 小時 ROAS ${Number(e.roas).toFixed(2)} 為目標的 ${Math.round(Number(e.ratio) * 100)}%`,
};

const ACTION_LABEL = (a: MonitorAction) => (a.kind === 'pause' ? '暫停' : a.kind === 'reduce_budget' ? `預算 −${Math.round(a.pct * 100)}%` : `出價目標收緊 ${Math.round(a.pct * 100)}%`);

/** Pause and budget cuts are the circuit breaker; target changes are bid_auto_reduce (ADR-0013). */
export const featureOf = (a: MonitorAction): AutomationFeature => (a.kind === 'reduce_target' ? 'bid_auto_reduce' : 'circuit_breaker');

/** The last `hours` local hours, current one included. */
export function hourSlots(now: Date, timeZone: string, hours: number): HourSlot[] {
  return Array.from({ length: hours }, (_, i) => {
    const at = new Date(now.getTime() - i * 3_600_000);
    return { date: dateInTimeZone(at, timeZone), hour: wallTime(at, timeZone).hour };
  });
}

export async function runMonitor(deps: MonitorDeps, account: AdAccount): Promise<Firing[]> {
  const { db, logger } = deps;
  const rules = await listMonitorRules(db, { accountId: account.id, enabledOnly: true });
  if (rules.length === 0) return [];
  const now = deps.now();
  const tz = account.timezone;
  const today = dateInTimeZone(now, tz);
  const w = wallTime(now, tz);
  const dayElapsed = (w.hour * 3600 + w.minute * 60 + w.second) / 86_400;

  const [campaigns, todaySpend, entityIds] = await Promise.all([listCampaigns(db, [account.id]), spendOn(db, account.id, 'campaign', today), loadEntityIds(db, account.id, ['account'])]);
  const accountEntityId = entityIds.get(`account:${account.externalId}`);
  const windows = new Map<number, Awaited<ReturnType<typeof hourlyTotals>>>();
  const windowFor = async (hours: number) => {
    if (!windows.has(hours)) windows.set(hours, await hourlyTotals(db, account.id, 'campaign', hourSlots(now, tz, hours)));
    return windows.get(hours)!;
  };
  let monthly: { mtd: number; cap: number | null } | undefined;
  const monthlyTotals = async () => {
    if (!monthly) {
      const [spend, rules] = await Promise.all([dailySpend(db, [account.id], `${today.slice(0, 8)}01`, today), loadRules(db, account.id)]);
      const cap = resolveRules(rules, { accountId: account.id }).find((r) => r.spec.type === 'MonthlySpendCap');
      monthly = { mtd: spend.reduce((s, d) => s + d.costMicros, 0), cap: cap?.spec.type === 'MonthlySpendCap' ? cap.spec.maxMicros : null };
    }
    return monthly;
  };

  const ref = (c: CampaignRow) => ({ platform: account.platform, accountId: account.externalId, kind: 'campaign' as const, id: c.externalId });
  const monitored = (c: CampaignRow) => ({ ref: ref(c), status: c.status, budgetMicros: c.budgetMicros, bidStrategy: c.bidStrategy, bidTarget: c.bidTarget });
  const scope = (rule: MonitorRule) => campaigns.filter((c) => (rule.campaignEntityId ? c.campaignId === rule.campaignEntityId : c.status === 'ENABLED'));

  async function campaignWindow(rule: MonitorRule, c: CampaignRow): Promise<MonitorWindow> {
    const spec = rule.spec;
    if (spec.type === 'SpendPacing') return { todaySpendMicros: todaySpend.get(c.campaignId) ?? 0, dayElapsed, dailyBudgetMicros: c.budgetMicros };
    const t = (spec.type === 'CpaSpike' || spec.type === 'RoasDrop' ? await windowFor(spec.hours) : new Map()).get(c.campaignId);
    const cpa = /TARGET_CPA|MAXIMIZE_CONVERSIONS$/.test(c.bidStrategy ?? '');
    return {
      windowCostMicros: t?.costMicros ?? 0,
      windowConversions: t?.conversions ?? 0,
      windowConvValue: t?.convValue ?? 0,
      targetCpaMicros: cpa ? c.bidTarget : null,
      targetRoas: cpa ? null : c.bidTarget,
    };
  }

  const firings: Firing[] = [];
  async function fire(rule: MonitorRule, entityId: string, label: string, evaluation: MonitorEvaluation, ops: Op[]) {
    if (inCooldown(await lastFiring(db, rule.id, entityId), rule.cooldownMinutes, now)) {
      logger.info({ rule_id: rule.id, entity_id: entityId }, 'monitor rule in cooldown');
      return;
    }
    const feature = featureOf(rule.action);
    // An automation that is off proposes nothing (ADR-0013).
    if ((await getAutomationMode(db, account.id, feature)) === 'off') return;
    let changesetId: string | null = null;
    if (ops.length && deps.propose) {
      const summary = `${feature === 'circuit_breaker' ? '熔斷' : '自動收緊出價'}：${label} ${RULE_LABEL[rule.spec.type](evaluation.evidence, account.currency)} → ${ACTION_LABEL(rule.action)}`;
      const cs = await deps.propose({
        accountId: account.id,
        feature,
        source: { kind: 'monitor', monitorRuleId: rule.id },
        ops,
        summary,
        rationale: `Monitor 規則 ${rule.spec.type}：${JSON.stringify(evaluation.evidence)}`,
        requestedBy: { kind: 'system' },
      });
      changesetId = cs.id;
    }
    await recordFiring(db, { ruleId: rule.id, entityId, firedAt: now, changesetId, evidence: evaluation.evidence });
    firings.push({ ruleId: rule.id, entityId, changesetId, evidence: evaluation.evidence });
    logger.info({ rule_id: rule.id, entity_id: entityId, changeset_id: changesetId }, 'monitor rule fired');
  }

  for (const rule of rules) {
    if (rule.spec.type === 'SpendNearCap') {
      // Account-wide: one evaluation, the action applied to every campaign in scope.
      if (!accountEntityId) continue;
      const { mtd, cap } = await monthlyTotals();
      const evaluation = evaluateMonitor(rule.spec, { mtdSpendMicros: mtd, monthlyCapMicros: cap });
      if (evaluation.triggered) await fire(rule, rule.campaignEntityId ?? accountEntityId, account.name, evaluation, scope(rule).flatMap((c) => monitorActionOps(rule.action, monitored(c))));
      continue;
    }
    for (const c of scope(rule)) {
      const evaluation = evaluateMonitor(rule.spec, await campaignWindow(rule, c));
      if (evaluation.triggered) await fire(rule, c.campaignId, c.name ?? c.externalId, evaluation, monitorActionOps(rule.action, monitored(c)));
    }
  }
  return firings;
}

export function monitorJobs(deps: MonitorDeps) {
  return [
    defineJob(Jobs.monitorRun, async ({ accountId }, ctx) => {
      const account = await getAdAccount(deps.db, accountId);
      if (!account?.active) return { skipped: true };
      const firings = await runMonitor({ ...deps, logger: ctx.logger }, account);
      return { fired: firings.length };
    }),
  ];
}
