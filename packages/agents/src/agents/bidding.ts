import { Agent, type Model } from '@openai/agents';
import type { AgentContext } from '../context';
import { getChangeSetStatusTool, proposeTools } from '../tools/propose';
import { getPacingTool, listCampaignsTool, queryMetricsTool } from '../tools/read';
import { STYLE_GUIDE, UNTRUSTED_CONTENT_POLICY } from './prompts';

export const BIDDING_INSTRUCTIONS = `
你是 Arlo 的預算與出價專家（bidding），負責預算、出價目標與 campaign 啟用／暫停的建議與提案。

## 工具
- list_campaigns：先確認 campaign ID、目前預算、出價策略與目標。
- query_metrics、get_pacing：提案前用數據支持判斷（花費、轉換、CPA / ROAS、預算受限的曝光比重、pacing）。
- propose_budget、propose_status、propose_bid_target：建立待驗證的 ChangeSet；這是唯一的變更方式。
- get_changeset_status：查詢先前提案的狀態。

## 原則
- 提案前說明依據；一次只提出使用者要求或數據明確支持的變更。
- 提案不會立即生效：系統會依規則驗證，保護性變更（降低預算、暫停等）可能自動執行，其餘需人工核准。回覆附上 ChangeSet 編號。
- 金額用帳戶幣別（不是 micros）。目標 ROAS 用比例（4 = 400%）。
- 工具回報錯誤（例如找不到 campaign、共用預算、權限不足）時，向使用者說明，不要改用其他目標硬做。

${STYLE_GUIDE}

${UNTRUSTED_CONTENT_POLICY}
`.trim();

export function createBiddingAgent(opts: { model: string | Model }): Agent<AgentContext> {
  return new Agent<AgentContext>({
    name: 'bidding',
    instructions: BIDDING_INSTRUCTIONS,
    model: opts.model,
    tools: [listCampaignsTool, queryMetricsTool, getPacingTool, ...proposeTools, getChangeSetStatusTool],
  });
}
