# ADR-0023：分級模型 + LLM 成本上限

- Status: Accepted
- Date: 2026-10-06
- Requirements: 19.1–19.3

## Decision
- `config/models.ts`：orchestrator / bidding / audit / campaign 用旗艦模型；search term 分類用小模型。模型名稱由環境設定覆寫。
- 每次 run 記錄 `llm_usage`（tokens、估算 USD、關聯 task/job/session）。
- 超過 `daily_llm_budget_usd` → 暫停非關鍵 job（`daily_report`、擴展類、`custom_prompt`）並通知；Monitor、Executor 不使用 LLM 不受影響；熔斷事後解釋降級為模板文字。

## Consequences
- 成本可預估；需要維護模型價格表。
