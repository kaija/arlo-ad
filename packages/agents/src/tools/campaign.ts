// Campaign tools (ADR-0020): the account's existing keywords for the Campaign agent, and
// create_campaign_task for the Orchestrator (a background task, not a write).
import { authorize, CampaignBriefSchema } from '@arlo/core';
import { getUserWithBindings, resolveAccounts, schema } from '@arlo/db';
import { tool, type RunContext } from '@openai/agents';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AgentContext } from '../context';
import { ToolInputError } from './read';

function ctxOf(runContext?: RunContext<AgentContext>): AgentContext {
  if (!runContext?.context?.db) throw new Error('agent context missing');
  return runContext.context;
}

export const GetAccountKeywordsParams = z.object({
  account: z.string().describe('帳戶名稱或 Google Ads customer ID'),
  contains: z.string().nullable().describe('只列出包含此字串的關鍵字'),
});

/** Active keywords already in the account, so new campaigns do not compete with them. */
export async function runGetAccountKeywords(ctx: AgentContext, p: z.infer<typeof GetAccountKeywordsParams>) {
  const [acc, more] = await resolveAccounts(ctx.db, { allowed: ctx.allowedAccountIds, account: p.account });
  if (!acc || more) throw new ToolInputError(`找不到唯一且有權限的帳戶「${p.account}」。`);
  const e = schema.entities;
  const rows = await ctx.db
    .select({ text: e.name, attrs: e.attrs, status: e.status })
    .from(e)
    .where(and(eq(e.accountId, acc.id), eq(e.kind, 'keyword'), sql`${e.status} is distinct from 'REMOVED'`, p.contains ? sql`${e.name} ilike ${`%${p.contains.replace(/[%_\\]/g, '\\$&')}%`}` : undefined))
    .limit(300);
  return { account: acc.name, keywords: rows.filter((r) => r.text).map((r) => ({ text: r.text, matchType: (r.attrs as { matchType?: string }).matchType ?? null, status: r.status })) };
}

export const getAccountKeywordsTool = tool({
  name: 'get_account_keywords',
  description: '列出帳戶現有的關鍵字（文字、比對類型、狀態），避免新 campaign 與既有關鍵字互相競爭。',
  parameters: GetAccountKeywordsParams,
  execute: (p, rc?: RunContext<AgentContext>) => runGetAccountKeywords(ctxOf(rc), p),
});

export const CreateCampaignTaskParams = z.object({
  account: z.string().describe('帳戶名稱或 Google Ads customer ID'),
  name: z.string().describe('campaign 名稱'),
  objective: z.string().describe('目標'),
  offering: z.string().describe('產品 / 服務與賣點'),
  landingPageUrl: z.string().describe('https 到達網頁'),
  audience: z.string().nullable(),
  locations: z.array(z.string()).describe('地區，例如 ["台灣"]'),
  languages: z.array(z.string()).describe('語言，例如 ["zh-TW"]'),
  dailyBudget: z.number().describe('每日預算（帳戶幣別）'),
  notes: z.string().nullable(),
});

export async function runCreateCampaignTask(ctx: AgentContext, p: z.infer<typeof CreateCampaignTaskParams>) {
  if (!ctx.createCampaignTask) throw new ToolInputError('這個情境不能建立 campaign 任務。');
  const [acc, more] = await resolveAccounts(ctx.db, { allowed: ctx.allowedAccountIds, account: p.account });
  if (!acc || more) throw new ToolInputError(`找不到唯一且有權限的帳戶「${p.account}」。`);
  if (ctx.user) {
    const user = await getUserWithBindings(ctx.db, ctx.user.id);
    if (!user || !authorize(user, 'propose', { accountId: acc.id }).allowed) throw new ToolInputError('發問者沒有在這個帳戶建立 campaign 的權限（需要 operator 以上）。');
  }
  const { account: _account, ...fields } = p;
  void _account;
  const brief = CampaignBriefSchema.safeParse(fields);
  if (!brief.success) throw new ToolInputError(`brief 不完整：${brief.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const task = await ctx.createCampaignTask({ accountId: acc.id, brief: brief.data, createdBy: ctx.user?.id ?? null });
  return { taskId: task.id, status: 'queued', note: 'Campaign agent 會在背景產生草稿；完成後可在 Web 的 Campaign 工作區編輯並送審。' };
}

export const createCampaignTaskTool = tool({
  name: 'create_campaign_task',
  description: '依使用者提供的 brief 建立背景 campaign 任務（產生 Search campaign 草稿，不會直接上線）。缺少資訊時先向使用者詢問。',
  parameters: CreateCampaignTaskParams,
  execute: (p, rc?: RunContext<AgentContext>) => runCreateCampaignTask(ctxOf(rc), p),
});
