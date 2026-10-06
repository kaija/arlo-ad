// propose_* tools (ADR-0006, Requirements 3.1, 3.2, 3.7): the only write path agents have. Each
// builds ops with `before` from the latest synced snapshot, stores a ChangeSet and queues it for
// the Executor. Nothing here can reach a platform mutate API.
import { authorize, formatMoney, microsToUnits, type EntityKind, type Op } from '@arlo/core';
import { getChangeSet, getUserWithBindings, listCampaigns, resolveAccounts, schema, type AdAccount, type CampaignRow } from '@arlo/db';
import { tool, type RunContext } from '@openai/agents';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AgentContext } from '../context';
import { ToolInputError } from './read';

const CPA = /^(TARGET_CPA|MAXIMIZE_CONVERSIONS)$/;
const ROAS = /^(TARGET_ROAS|MAXIMIZE_CONVERSION_VALUE)$/;

function ctxOf(runContext?: RunContext<AgentContext>): AgentContext {
  if (!runContext?.context?.db) throw new Error('agent context missing');
  return runContext.context;
}

/** One account the caller may propose changes for. */
async function proposalAccount(ctx: AgentContext, account: string): Promise<AdAccount> {
  if (!ctx.propose) throw new ToolInputError('這個情境不允許提出變更。');
  const [acc, more] = await resolveAccounts(ctx.db, { allowed: ctx.allowedAccountIds, account });
  if (!acc) throw new ToolInputError(`找不到你有權限的帳戶「${account}」。可先呼叫 list_campaigns。`);
  if (more) throw new ToolInputError(`「${account}」對應到多個帳戶，請改用 customer ID。`);
  if (ctx.user) {
    const user = await getUserWithBindings(ctx.db, ctx.user.id);
    if (!user || !authorize(user, 'propose', { accountId: acc.id }).allowed) {
      throw new ToolInputError('發問者沒有在這個帳戶提出變更的權限（需要 operator 以上）。');
    }
  }
  return acc;
}

async function findCampaign(ctx: AgentContext, acc: AdAccount, campaign: string): Promise<CampaignRow> {
  const rows = await listCampaigns(ctx.db, [acc.id]);
  const wanted = campaign.trim().toLowerCase();
  const matches = rows.filter((c) => c.externalId === campaign.trim() || c.campaignId === campaign.trim() || c.name?.toLowerCase() === wanted);
  if (matches.length === 0) throw new ToolInputError(`找不到 campaign「${campaign}」。可先呼叫 list_campaigns。`);
  if (matches.length > 1) throw new ToolInputError(`「${campaign}」對應到多個 campaign，請改用 campaign ID。`);
  if (!matches[0]!.snapshotAt) throw new ToolInputError('這個 campaign 尚未同步狀態，暫時無法提出變更。');
  return matches[0]!;
}

const ref = (acc: AdAccount, kind: EntityKind, id: string) => ({ platform: acc.platform, accountId: acc.externalId, kind, id });

async function submit(ctx: AgentContext, acc: AdAccount, ops: Op[], summary: string, rationale: string | null) {
  const cs = await ctx.propose!({
    accountId: acc.id,
    source: ctx.source ?? { kind: 'chat' },
    ops,
    summary,
    rationale,
    requestedBy: ctx.user ? { kind: 'user', userId: ctx.user.id } : { kind: 'agent' },
    traceId: ctx.traceId ?? null,
  });
  return {
    changesetId: cs.id,
    status: 'PENDING_VALIDATION',
    summary,
    note: '已送出。系統會先以規則驗證，保護性變更可能自動執行，其餘送審核；請告知使用者 ChangeSet 編號，不要宣稱已生效。',
  };
}

const accountParam = z.string().describe('帳戶名稱或 Google Ads customer ID');
const reasonParam = z.string().nullable().describe('提出這項變更的理由（會顯示在審核卡片）');

// --- propose_budget ----------------------------------------------------------------------

export const ProposeBudgetParams = z.object({
  account: accountParam,
  campaign: z.string().describe('campaign ID 或名稱'),
  dailyBudget: z.number().positive().describe('新的每日預算，帳戶幣別的金額（不是 micros）'),
  reason: reasonParam,
});

export async function runProposeBudget(ctx: AgentContext, p: z.infer<typeof ProposeBudgetParams>) {
  const acc = await proposalAccount(ctx, p.account);
  const c = await findCampaign(ctx, acc, p.campaign);
  const [entity] = await ctx.db.select({ attrs: schema.entities.attrs }).from(schema.entities).where(eq(schema.entities.id, c.campaignId));
  if ((entity?.attrs as { budgetShared?: boolean } | undefined)?.budgetShared) throw new ToolInputError('這個 campaign 使用共用預算，調整會影響其他 campaign，目前不支援。');
  if (c.budgetMicros === null) throw new ToolInputError('這個 campaign 沒有可調整的每日預算。');
  const after = Math.round(p.dailyBudget * 1_000_000);
  if (after === c.budgetMicros) throw new ToolInputError('新預算與目前相同。');
  const op: Op = { kind: 'set_budget', target: ref(acc, 'campaign', c.externalId), field: 'budget_micros', before: c.budgetMicros, after };
  return submit(ctx, acc, [op], `${c.name ?? c.externalId} 每日預算 ${formatMoney(c.budgetMicros, acc.currency)} → ${formatMoney(after, acc.currency)}`, p.reason);
}

// --- propose_status ----------------------------------------------------------------------

export const ProposeStatusParams = z.object({
  account: accountParam,
  level: z.enum(['campaign', 'ad_group', 'keyword']).describe('目標層級'),
  ids: z.array(z.string()).min(1).max(50).describe('目標 ID（campaign / ad group ID；關鍵字為 adGroupId~criterionId）或 campaign 名稱'),
  status: z.enum(['ENABLED', 'PAUSED']),
  reason: reasonParam,
});

export async function runProposeStatus(ctx: AgentContext, p: z.infer<typeof ProposeStatusParams>) {
  const acc = await proposalAccount(ctx, p.account);
  const ids = [...new Set(p.ids.map((s) => s.trim()))];
  const rows = await ctx.db
    .select({ externalId: schema.entities.externalId, name: schema.entities.name, status: schema.entities.status })
    .from(schema.entities)
    .where(
      and(
        eq(schema.entities.accountId, acc.id),
        eq(schema.entities.kind, p.level),
        sql`${schema.entities.status} is distinct from 'REMOVED'`,
        p.level === 'campaign' ? sql`(${schema.entities.externalId} = any(${sql.param(ids)}::text[]) or lower(${schema.entities.name}) = any(${sql.param(ids.map((i) => i.toLowerCase()))}::text[]))` : inArray(schema.entities.externalId, ids),
      ),
    );
  if (rows.length === 0) throw new ToolInputError('找不到指定的目標。');
  const found = new Set(rows.flatMap((r) => [r.externalId, r.name?.toLowerCase()]));
  const missing = ids.filter((i) => !found.has(i) && !found.has(i.toLowerCase()));
  if (missing.length) throw new ToolInputError(`找不到：${missing.join(', ')}`);
  const changing = rows.filter((r) => r.status !== p.status);
  if (changing.length === 0) throw new ToolInputError(`目標已經是 ${p.status}。`);
  const ops: Op[] = changing.map((r) => ({ kind: 'set_status', target: ref(acc, p.level, r.externalId), field: 'status', before: r.status, after: p.status }));
  const verb = p.status === 'PAUSED' ? '暫停' : '啟用';
  const label = changing.length === 1 ? (changing[0]!.name ?? changing[0]!.externalId) : `${changing.length} 個${{ campaign: 'campaign', ad_group: '廣告群組', keyword: '關鍵字' }[p.level]}`;
  return submit(ctx, acc, ops, `${verb} ${label}`, p.reason);
}

// --- propose_bid_target ------------------------------------------------------------------

export const ProposeBidTargetParams = z.object({
  account: accountParam,
  campaign: z.string().describe('campaign ID 或名稱'),
  targetCpa: z.number().positive().nullable().describe('新的目標 CPA，帳戶幣別金額；用於 tCPA / 最大化轉換'),
  targetRoas: z.number().positive().nullable().describe('新的目標 ROAS，比例（4 = 400%）；用於 tROAS / 最大化轉換價值'),
  reason: reasonParam,
});

export async function runProposeBidTarget(ctx: AgentContext, p: z.infer<typeof ProposeBidTargetParams>) {
  if ((p.targetCpa === null) === (p.targetRoas === null)) throw new ToolInputError('targetCpa 與 targetRoas 需剛好提供一個。');
  const acc = await proposalAccount(ctx, p.account);
  const c = await findCampaign(ctx, acc, p.campaign);
  const strategy = c.bidStrategy ?? '';
  const name = c.name ?? c.externalId;
  if (p.targetCpa !== null) {
    if (!CPA.test(strategy)) throw new ToolInputError(`這個 campaign 的出價策略是 ${strategy || '未知'}，沒有目標 CPA。`);
    const after = Math.round(p.targetCpa * 1_000_000);
    const op: Op = { kind: 'set_bid_target', target: ref(acc, 'campaign', c.externalId), field: 'target_cpa_micros', before: c.bidTarget, after };
    return submit(ctx, acc, [op], `${name} 目標 CPA ${formatMoney(c.bidTarget, acc.currency)} → ${formatMoney(after, acc.currency)}`, p.reason);
  }
  if (!ROAS.test(strategy)) throw new ToolInputError(`這個 campaign 的出價策略是 ${strategy || '未知'}，沒有目標 ROAS。`);
  const op: Op = { kind: 'set_bid_target', target: ref(acc, 'campaign', c.externalId), field: 'target_roas', before: c.bidTarget, after: p.targetRoas };
  const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
  return submit(ctx, acc, [op], `${name} 目標 ROAS ${pct(c.bidTarget)} → ${pct(p.targetRoas)}`, p.reason);
}

// --- get_changeset_status ----------------------------------------------------------------

export const GetChangeSetStatusParams = z.object({ changesetId: z.string().describe('ChangeSet 編號') });

export async function runGetChangeSetStatus(ctx: AgentContext, p: z.infer<typeof GetChangeSetStatusParams>) {
  if (!/^[0-9a-f-]{36}$/i.test(p.changesetId)) throw new ToolInputError('ChangeSet 編號格式不正確。');
  const cs = await getChangeSet(ctx.db, p.changesetId);
  if (!cs || (ctx.allowedAccountIds && !ctx.allowedAccountIds.includes(cs.accountId))) throw new ToolInputError('找不到這個 ChangeSet。');
  return {
    changesetId: cs.id,
    summary: cs.summary,
    status: cs.status,
    tier: cs.tier,
    reason: cs.statusReason,
    violations: cs.violations.map((v) => ({ severity: v.severity, message: v.message })),
    expiresAt: cs.expiresAt?.toISOString() ?? null,
    executedAt: cs.executedAt?.toISOString() ?? null,
    ops: cs.ops.map((op) => ({ kind: op.kind, target: `${op.target.kind} ${op.target.id}`, before: op.field === 'budget_micros' || op.field === 'target_cpa_micros' ? microsToUnits(op.before as number) : op.before, after: op.field === 'budget_micros' || op.field === 'target_cpa_micros' ? microsToUnits(op.after as number) : op.after })),
  };
}

// --- tool definitions ----------------------------------------------------------------------

export const proposeBudgetTool = tool({
  name: 'propose_budget',
  description: '提出調整 campaign 每日預算的變更（建立待驗證的 ChangeSet，不會直接生效）。',
  parameters: ProposeBudgetParams,
  execute: (p, rc?: RunContext<AgentContext>) => runProposeBudget(ctxOf(rc), p),
});

export const proposeStatusTool = tool({
  name: 'propose_status',
  description: '提出暫停或啟用 campaign / 廣告群組 / 關鍵字的變更（建立待驗證的 ChangeSet，不會直接生效）。',
  parameters: ProposeStatusParams,
  execute: (p, rc?: RunContext<AgentContext>) => runProposeStatus(ctxOf(rc), p),
});

export const proposeBidTargetTool = tool({
  name: 'propose_bid_target',
  description: '提出調整 campaign 目標 CPA 或目標 ROAS 的變更（建立待驗證的 ChangeSet，不會直接生效）。',
  parameters: ProposeBidTargetParams,
  execute: (p, rc?: RunContext<AgentContext>) => runProposeBidTarget(ctxOf(rc), p),
});

export const getChangeSetStatusTool = tool({
  name: 'get_changeset_status',
  description: '查詢 ChangeSet 的目前狀態（待審核、已執行、被擋下等）與原因。',
  parameters: GetChangeSetStatusParams,
  execute: (p, rc?: RunContext<AgentContext>) => runGetChangeSetStatus(ctxOf(rc), p),
});

export const proposeTools = [proposeBudgetTool, proposeStatusTool, proposeBidTargetTool];
