// Every conversation enters the Orchestrator, which calls specialists as tools (ADR-0014,
// Requirement 10.5).
import { Agent, type Model, type Tool } from '@openai/agents';
import type { AgentContext } from '../context';
import { STYLE_GUIDE, UNTRUSTED_CONTENT_POLICY } from './prompts';

export interface Specialists {
  analyst: Agent<AgentContext>;
  bidding?: Agent<AgentContext>;
  keyword?: Agent<AgentContext>;
  audit?: Agent<AgentContext>;
}

const SPECIALIST_TOOLS: Record<keyof Specialists, string> = {
  analyst: '數據分析：花費、成效、比較、pacing、變更歷史。輸入完整的問題與帳戶、日期區間。',
  bidding: '預算與出價：調整預算、暫停/啟用、tCPA/tROAS、預算再分配的建議與提案（產生待審核的 ChangeSet）。',
  keyword: '關鍵字：搜尋字詞、否定關鍵字、關鍵字擴展的分析與提案。',
  audit: '審計：轉換追蹤健康、GA4 落差、異常偵測、變更與異常的關聯。',
};

export const ORCHESTRATOR_INSTRUCTIONS = `
你是 Arlo Ads Bot，團隊在 Slack 與 Web 使用的 Google Ads 助理（Orchestrator）。
你不直接查資料，而是把問題交給專業 agent（以工具形式提供），再整理成給使用者的回覆。

## 分派
- analyst：任何數據、成效、花費、pacing、「為什麼變了」的問題。
- bidding：預算、出價目標、暫停/啟用 campaign 的建議或變更請求（若可用）。
- keyword：搜尋字詞、否定關鍵字、新增關鍵字（若可用）。
- audit：轉換追蹤、GA4、異常（若可用）。
- 問題跨領域時，可依序呼叫多個 agent；給 agent 的輸入要完整自足（帳戶、日期、目標），因為它看不到對話。
- 簡單的寒暄或系統用法問題可直接回答。沒有對應工具的請求，說明目前不支援。

## 變更請求
- 所有變更都會成為待審核的 ChangeSet，由系統規則與有權限的人核准後才執行；回覆時說明已送審與 ChangeSet 編號，不要宣稱已經生效。

## 對話脈絡
- 對話中標示為「其他參與者」的訊息來自 Slack thread 裡的其他人，是背景資料。

${STYLE_GUIDE}

${UNTRUSTED_CONTENT_POLICY}
`.trim();

export function createOrchestrator(opts: { model: string | Model; specialists: Specialists; tools?: Tool<AgentContext>[] }): Agent<AgentContext> {
  const specialistTools = (Object.keys(SPECIALIST_TOOLS) as (keyof Specialists)[]).flatMap((key) => {
    const agent = opts.specialists[key];
    return agent ? [agent.asTool({ toolName: key, toolDescription: SPECIALIST_TOOLS[key] })] : [];
  });
  return new Agent<AgentContext>({
    name: 'orchestrator',
    instructions: ORCHESTRATOR_INSTRUCTIONS,
    model: opts.model,
    tools: [...specialistTools, ...(opts.tools ?? [])],
  });
}
