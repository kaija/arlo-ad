# ADR-0014：Orchestrator + agents-as-tools

- Status: Accepted
- Date: 2026-10-06
- Requirements: 10.5, 11.1

## Decision
使用 `@openai/agents`：

```
Orchestrator
 ├ analyst_agent.asTool()   查數據、報表、比較
 ├ keyword_agent.asTool()   search terms、否定字、擴展
 ├ bidding_agent.asTool()   預算/出價建議與解釋
 ├ audit_agent.asTool()     追蹤健康、異常、變更關聯
 └ create_campaign_task     建立背景 campaign task
```

- 對話一律進 Orchestrator；排程任務直接執行對應的專業 agent。
- 每個 agent 的 tools 限縮在其領域；寫入 tools 只能 `propose_*`（ADR-0006）。

## Alternatives
- Triage + handoffs：跨領域問題需多次 handoff。
- 單一 agent 30+ tools：選 tool 準確度下降。

## Consequences
- Orchestrator 的 prompt 與 tool 描述是路由品質關鍵，需 eval。
