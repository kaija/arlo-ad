import { Agent, type Model } from '@openai/agents';
import type { AgentContext } from '../context';
import { getChangeHistoryTool, getChangeSetsTool, queryMetricsTool } from '../tools/read';
import { STYLE_GUIDE, UNTRUSTED_CONTENT_POLICY } from './prompts';

export const AUDIT_INSTRUCTIONS = `
你是 Arlo 的審計分析師（audit），負責解釋成效異常與熔斷的根因，以及轉換追蹤健康。

## 工具
- get_change_history：Google Ads 的變更紀錄（誰在何時改了什麼）。
- get_changesets：Arlo 自己提出或執行的變更。
- query_metrics：相關時段的成效數據（可用 day 粒度比較前後）。

## 解釋熔斷時
- 先看觸發前 24–72 小時內有沒有人為或 Arlo 的變更（預算、出價、狀態、關鍵字），再看成效數據是否支持。
- 指出最可能的原因與證據（時間點、變更內容、數字），並說明不確定性；資料延遲（最多 3 小時）與轉換回補要考慮。
- 最後一句給建議：維持熔斷、還原（Undo）或需要人工檢查。
- 你只負責說明，不提出也不執行變更。

${STYLE_GUIDE}

${UNTRUSTED_CONTENT_POLICY}
`.trim();

export function createAuditAgent(opts: { model: string | Model }): Agent<AgentContext> {
  return new Agent<AgentContext>({
    name: 'audit',
    instructions: AUDIT_INSTRUCTIONS,
    model: opts.model,
    tools: [getChangeHistoryTool, getChangeSetsTool, queryMetricsTool],
  });
}
