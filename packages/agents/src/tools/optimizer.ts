// Budget reallocation tools (ADR-0018, Requirements 13.3, 13.4). The optimizer computes every
// number; the agent can only read a result, exclude campaigns and explain. Proposals reference a
// stored run by id, so a model cannot inject budgets.
import { authorize, formatMoney, microsToUnits, planReallocation, suggestBidTarget, type BidTargetSuggestion, type Op, type OptimizerCampaign, type ReallocationPlan } from '@arlo/core';
import { claimOptimizerRun, getAdAccount, linkOptimizerRun, getOptimizerRun, getUserWithBindings, listCampaigns, loadOptimizerInputs, resolveAccounts, saveOptimizerRun, type AdAccount } from '@arlo/db';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentContext } from '../context';
import { ToolInputError } from './read';

export const DEFAULT_REALLOCATION_MAX_CHANGE = 0.3;
export const DEFAULT_REALLOCATION_MIN_CONVERSIONS = 30;
/** A run older than this is stale: budgets and data have moved on. */
const RUN_TTL_MS = 24 * 3_600_000;

function ctxOf(runContext?: RunContext<AgentContext>): AgentContext {
  if (!runContext?.context?.db) throw new Error('agent context missing');
  return runContext.context;
}

const present = (plan: ReallocationPlan, currency: string) => ({
  total: formatMoney(plan.totalMicros, currency),
  expectedDailyGain: Math.round(plan.expectedGain * 100) / 100,
  empty: plan.empty,
  campaigns: plan.campaigns.map((c) => ({
    campaignId: c.id,
    name: c.name,
    before: microsToUnits(c.before),
    after: microsToUnits(c.after),
    changePct: c.before ? Math.round((c.delta / c.before) * 1000) / 10 : 0,
    locked: c.locked,
    basis: c.reason,
  })),
});

// --- run_budget_optimizer ----------------------------------------------------------------------

export const RunBudgetOptimizerParams = z.object({
  account: z.string().describe('帳戶名稱或 Google Ads customer ID'),
  optimizeFor: z.enum(['conversions', 'value']).nullable().describe('轉換數或轉換價值，預設轉換數'),
});

export async function runBudgetOptimizer(ctx: AgentContext, p: z.infer<typeof RunBudgetOptimizerParams>) {
  const [acc, more] = await resolveAccounts(ctx.db, { allowed: ctx.allowedAccountIds, account: p.account });
  if (!acc || more) throw new ToolInputError(`找不到唯一且有權限的帳戶「${p.account}」。`);
  const inputs = await loadOptimizerInputs(ctx.db, acc, ctx.now(), { valueBased: p.optimizeFor === 'value' });
  const plan = planReallocation(inputs, { maxChangePct: DEFAULT_REALLOCATION_MAX_CHANGE, minConversions: DEFAULT_REALLOCATION_MIN_CONVERSIONS });
  const run = await saveOptimizerRun(ctx.db, { accountId: acc.id, inputs, plan, maxChangePct: DEFAULT_REALLOCATION_MAX_CHANGE, minConversions: DEFAULT_REALLOCATION_MIN_CONVERSIONS });
  return {
    resultId: run.id,
    account: acc.name,
    ...present(plan, acc.currency),
    note: '數字由 optimizer 計算，不可修改；你可以排除不該調整的 campaign 並撰寫解釋，再用 propose_budget_reallocation 送審。',
  };
}

// --- propose_budget_reallocation ------------------------------------------------------------

export const ProposeBudgetReallocationParams = z.object({
  resultId: z.string().describe('run_budget_optimizer 回傳的 resultId'),
  excludeCampaigns: z.array(z.string()).max(50).describe('要排除（維持原預算）的 campaign ID；沒有就給空陣列'),
  explanation: z.string().min(1).max(2000).describe('給審核者的解釋：為什麼這樣分配、排除了什麼與原因'),
});

export async function runProposeBudgetReallocation(ctx: AgentContext, p: z.infer<typeof ProposeBudgetReallocationParams>) {
  if (!ctx.propose) throw new ToolInputError('這個情境不允許提出變更。');
  if (!/^[0-9a-f-]{36}$/i.test(p.resultId)) throw new ToolInputError('resultId 格式不正確。');
  const run = await getOptimizerRun(ctx.db, p.resultId);
  if (!run || (ctx.allowedAccountIds && !ctx.allowedAccountIds.includes(run.accountId))) throw new ToolInputError('找不到這個 optimizer 結果。');
  if (run.usedAt) throw new ToolInputError('這個 optimizer 結果已經送審過。');
  if (ctx.now().getTime() - run.createdAt.getTime() > RUN_TTL_MS) throw new ToolInputError('optimizer 結果已超過 24 小時，請重新執行 run_budget_optimizer。');
  const acc = await getAdAccount(ctx.db, run.accountId);
  if (!acc) throw new ToolInputError('找不到帳戶。');
  if (ctx.user) {
    const user = await getUserWithBindings(ctx.db, ctx.user.id);
    if (!user || !authorize(user, 'propose', { accountId: acc.id }).allowed) throw new ToolInputError('發問者沒有在這個帳戶提出變更的權限（需要 operator 以上）。');
  }

  const inputs = run.inputs as OptimizerCampaign[];
  const known = new Set(inputs.map((c) => c.id));
  const unknown = p.excludeCampaigns.filter((id) => !known.has(id));
  if (unknown.length) throw new ToolInputError(`不在這次 optimizer 結果中的 campaign：${unknown.join(', ')}`);
  // Exclusions only lock campaigns; the optimizer recomputes the rest from the stored inputs.
  const plan = planReallocation(inputs, { maxChangePct: run.maxChangePct, minConversions: run.minConversions, exclude: p.excludeCampaigns });
  const changed = plan.campaigns.filter((c) => c.delta !== 0);
  if (plan.empty || changed.length === 0) throw new ToolInputError('排除後沒有可調整的預算。');

  const ops: Op[] = changed.map((c) => ({
    kind: 'set_budget',
    target: { platform: acc.platform, accountId: acc.externalId, kind: 'campaign', id: c.id },
    field: 'budget_micros',
    before: c.before,
    after: c.after,
    // Reallocation is always reviewed, even the reductions (Requirement 13.4).
    meta: { minTier: 2, optimizerRunId: run.id },
  }));
  if (!(await claimOptimizerRun(ctx.db, run.id, ctx.now()))) throw new ToolInputError('這個 optimizer 結果已經送審過。');
  const cs = await ctx.propose({
    accountId: acc.id,
    feature: 'budget_rebalance',
    source: ctx.source ?? { kind: 'chat' },
    ops,
    summary: `預算再分配：${changed.length} 個 campaign，總額 ${formatMoney(plan.totalMicros, acc.currency)} 不變`,
    rationale: p.explanation,
    requestedBy: ctx.user ? { kind: 'user', userId: ctx.user.id } : { kind: 'agent' },
    traceId: ctx.traceId ?? null,
  });
  await linkOptimizerRun(ctx.db, run.id, cs.id);
  return { changesetId: cs.id, status: 'PENDING_VALIDATION', ...present(plan, acc.currency), note: '預算再分配一律需要人工核准（Tier 2 以上）。回覆附上 ChangeSet 編號。' };
}

export const runBudgetOptimizerTool = tool({
  name: 'run_budget_optimizer',
  description: '以決定性 optimizer 計算帳戶內 campaign 的預算再分配（總額不變、單一 campaign 變動 ≤ 30%、跳過學習中或資料不足者），回傳 resultId 與建議分配。',
  parameters: RunBudgetOptimizerParams,
  execute: (p, rc?: RunContext<AgentContext>) => runBudgetOptimizer(ctxOf(rc), p),
});

export const proposeBudgetReallocationTool = tool({
  name: 'propose_budget_reallocation',
  description: '把 optimizer 結果送審（只能指定 resultId、排除的 campaign 與解釋，不能修改數字）。',
  parameters: ProposeBudgetReallocationParams,
  execute: (p, rc?: RunContext<AgentContext>) => runProposeBudgetReallocation(ctxOf(rc), p),
});

// --- tCPA / tROAS tuning (Requirement 13.5) ----------------------------------------------------

export const MAX_BID_TARGET_STEP = 0.15;

interface BidSuggestionRow {
  campaignId: string;
  name: string;
  suggestion: BidTargetSuggestion;
}

/** Deterministic suggestions for every enabled campaign with a target. */
export async function bidTargetSuggestions(ctx: AgentContext, acc: AdAccount): Promise<BidSuggestionRow[]> {
  const [campaigns, inputs] = await Promise.all([listCampaigns(ctx.db, [acc.id]), loadOptimizerInputs(ctx.db, acc, ctx.now(), { valueBased: false })]);
  const values = await loadOptimizerInputs(ctx.db, acc, ctx.now(), { valueBased: true });
  return inputs.flatMap((input) => {
    const c = campaigns.find((x) => x.externalId === input.id);
    if (!c) return [];
    const value = values.find((v) => v.id === input.id);
    const suggestion = suggestBidTarget(
      {
        bidStrategy: c.bidStrategy,
        currentTarget: c.bidTarget,
        costMicros: input.history.reduce((s, d) => s + d.costMicros, 0),
        conversions: input.history.reduce((s, d) => s + d.value, 0),
        convValue: value ? value.history.reduce((s, d) => s + d.value, 0) : 0,
        learning: input.learning,
      },
      { maxStepPct: MAX_BID_TARGET_STEP },
    );
    return [{ campaignId: input.id, name: input.name, suggestion }];
  });
}

async function scopedAccount(ctx: AgentContext, account: string): Promise<AdAccount> {
  const [acc, more] = await resolveAccounts(ctx.db, { allowed: ctx.allowedAccountIds, account });
  if (!acc || more) throw new ToolInputError(`找不到唯一且有權限的帳戶「${account}」。`);
  return acc;
}

const showSuggestion = (r: BidSuggestionRow, currency: string) =>
  r.suggestion.action === 'skip'
    ? { campaignId: r.campaignId, name: r.name, action: 'skip', reason: r.suggestion.reason }
    : {
        campaignId: r.campaignId,
        name: r.name,
        action: 'adjust',
        target: r.suggestion.field === 'target_roas' ? 'tROAS' : 'tCPA',
        before: r.suggestion.field === 'target_roas' ? r.suggestion.before : formatMoney(r.suggestion.before, currency),
        after: r.suggestion.field === 'target_roas' ? r.suggestion.after : formatMoney(r.suggestion.after, currency),
        reason: r.suggestion.reason,
      };

export const SuggestBidTargetsParams = z.object({ account: z.string().describe('帳戶名稱或 Google Ads customer ID') });

export async function runSuggestBidTargets(ctx: AgentContext, p: z.infer<typeof SuggestBidTargetsParams>) {
  const acc = await scopedAccount(ctx, p.account);
  return { account: acc.name, maxStepPct: MAX_BID_TARGET_STEP, suggestions: (await bidTargetSuggestions(ctx, acc)).map((r) => showSuggestion(r, acc.currency)) };
}

export const ProposeBidTargetAdjustmentsParams = z.object({
  account: z.string().describe('帳戶名稱或 Google Ads customer ID'),
  campaigns: z.array(z.string()).min(1).max(50).describe('要套用建議的 campaign ID（來自 suggest_bid_targets）'),
  reason: z.string().max(1000).nullable(),
});

/** Proposes the computed suggestions for the chosen campaigns; values cannot be supplied. */
export async function runProposeBidTargetAdjustments(ctx: AgentContext, p: z.infer<typeof ProposeBidTargetAdjustmentsParams>) {
  if (!ctx.propose) throw new ToolInputError('這個情境不允許提出變更。');
  const acc = await scopedAccount(ctx, p.account);
  if (ctx.user) {
    const user = await getUserWithBindings(ctx.db, ctx.user.id);
    if (!user || !authorize(user, 'propose', { accountId: acc.id }).allowed) throw new ToolInputError('發問者沒有在這個帳戶提出變更的權限（需要 operator 以上）。');
  }
  const rows = await bidTargetSuggestions(ctx, acc);
  const chosen = rows.filter((r) => p.campaigns.includes(r.campaignId));
  const skipped = chosen.filter((r) => r.suggestion.action === 'skip');
  if (chosen.length !== new Set(p.campaigns).size) throw new ToolInputError('有 campaign 不在建議清單中。');
  if (skipped.length) throw new ToolInputError(`這些 campaign 目前不建議調整：${skipped.map((r) => `${r.name}（${(r.suggestion as { reason: string }).reason}）`).join('、')}`);
  const ops: Op[] = chosen.map((r) => {
    const s = r.suggestion as Extract<BidTargetSuggestion, { action: 'adjust' }>;
    return { kind: 'set_bid_target', target: { platform: acc.platform, accountId: acc.externalId, kind: 'campaign', id: r.campaignId }, field: s.field, before: s.before, after: s.after, meta: { actual: s.actual } };
  });
  const cs = await ctx.propose({
    accountId: acc.id,
    source: ctx.source ?? { kind: 'chat' },
    ops,
    summary: `微調 ${ops.length} 個 campaign 的出價目標（每次 ≤ ±${MAX_BID_TARGET_STEP * 100}%）`,
    rationale: [p.reason, ...chosen.map((r) => `${r.name}：${(r.suggestion as { reason: string }).reason}`)].filter(Boolean).join('\n'),
    requestedBy: ctx.user ? { kind: 'user', userId: ctx.user.id } : { kind: 'agent' },
    traceId: ctx.traceId ?? null,
  });
  return { changesetId: cs.id, status: 'PENDING_VALIDATION', adjustments: chosen.map((r) => showSuggestion(r, acc.currency)) };
}

export const suggestBidTargetsTool = tool({
  name: 'suggest_bid_targets',
  description: '依近 14 天實際 CPA / ROAS 計算各 campaign 出價目標的建議微調（每次 ≤ ±15%，跳過學習中與資料不足者）。',
  parameters: SuggestBidTargetsParams,
  execute: (p, rc?: RunContext<AgentContext>) => runSuggestBidTargets(ctxOf(rc), p),
});

export const proposeBidTargetAdjustmentsTool = tool({
  name: 'propose_bid_target_adjustments',
  description: '把 suggest_bid_targets 的建議值送審（只能選擇 campaign，數值由系統計算）。',
  parameters: ProposeBidTargetAdjustmentsParams,
  execute: (p, rc?: RunContext<AgentContext>) => runProposeBidTargetAdjustments(ctxOf(rc), p),
});
