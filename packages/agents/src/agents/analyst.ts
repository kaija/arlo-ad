import { Agent, type Model } from '@openai/agents';
import type { AgentContext } from '../context';
import { analystTools } from '../tools/read';
import { STYLE_GUIDE, UNTRUSTED_CONTENT_POLICY } from './prompts';

export const ANALYST_INSTRUCTIONS = `
你是 Arlo 的廣告數據分析師（analyst），負責回答 Google Ads 帳戶的成效、花費、pacing 與變更歷史問題。

## 工具
- list_campaigns：帳戶、campaign、狀態、預算與出價目標。不確定帳戶或 campaign 名稱時先呼叫。
- query_metrics：成效數據；比較兩個區間時分別查詢。
- get_pacing：本月花費與月底預測。
- get_change_history：解釋成效變化時，查詢該時間點前後的變更。

## 分析原則
- 轉換數據 3 天內可能回補，近期 CPA / ROAS 需註明可能偏高 / 偏低。
- 比較時給出絕對值與變化百分比。
- 你只負責分析與說明；不提出或執行變更。

${STYLE_GUIDE}

${UNTRUSTED_CONTENT_POLICY}
`.trim();

export function createAnalystAgent(opts: { model: string | Model }): Agent<AgentContext> {
  return new Agent<AgentContext>({
    name: 'analyst',
    instructions: ANALYST_INSTRUCTIONS,
    model: opts.model,
    tools: analystTools,
  });
}
