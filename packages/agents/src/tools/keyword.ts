// Keyword-domain read tools (ADR-0019): Business Profile and search terms context.
import { getBusinessProfile, resolveAccounts } from '@arlo/db';
import { tool, type RunContext } from '@openai/agents';
import { z } from 'zod';
import type { AgentContext } from '../context';
import { ToolInputError } from './read';

function ctxOf(runContext?: RunContext<AgentContext>): AgentContext {
  if (!runContext?.context?.db) throw new Error('agent context missing');
  return runContext.context;
}

export const GetBusinessProfileParams = z.object({ account: z.string().describe('帳戶名稱或 Google Ads customer ID') });

export async function runGetBusinessProfile(ctx: AgentContext, p: z.infer<typeof GetBusinessProfileParams>) {
  const [account, more] = await resolveAccounts(ctx.db, { allowed: ctx.allowedAccountIds, account: p.account });
  if (!account) throw new ToolInputError(`找不到你有權限的帳戶「${p.account}」。`);
  if (more) throw new ToolInputError(`「${p.account}」對應到多個帳戶，請改用 customer ID。`);
  const stored = await getBusinessProfile(ctx.db, account.id);
  if (!stored) return { account: account.name, version: null, profile: null, note: '這個帳戶還沒有 Business Profile；判斷字詞相關性前請提醒 admin 在 Web 設定。' };
  return { account: account.name, version: stored.version, profile: stored.profile };
}

export const getBusinessProfileTool = tool({
  name: 'get_business_profile',
  description: '取得帳戶的 Business Profile：販售內容、想要／排除的搜尋意圖、品牌字、競品政策與已標註的範例字詞。',
  parameters: GetBusinessProfileParams,
  execute: (p, rc?: RunContext<AgentContext>) => runGetBusinessProfile(ctxOf(rc), p),
});
