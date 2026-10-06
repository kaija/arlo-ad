# ADR-0006：Agent 只產生 ChangeSet，決定性 Executor 執行

- Status: Accepted
- Date: 2026-10-06
- Requirements: 3.1–3.7

## Context
LLM 可能幻覺或遭 prompt injection（例如 search term、Slack 訊息內含惡意指令）。寫入廣告帳戶直接影響金錢。

## Decision
- Agent 寫入類 tool（`propose_*`）只建立 ChangeSet 寫入 DB，**不呼叫 mutate API**。
- 唯一能 mutate 的元件是 Executor（不含 LLM），流程：

```
validator → tier → (approval) → re-fetch & diff → mutate → audit log
```

- Approve 後不 resume agent run；結果由 Executor 透過 ChatAdapter 回報到原對話。
- `PlatformAdapter.applyOps()` 只能由 Executor 模組呼叫（以 package 邊界 + lint rule 強制）。

## Alternatives
- SDK `needsApproval` interruption：需長期保存 RunState，且決定性邊界在 agent run 內。
- 混合：兩條 mutate 路徑，稽核與驗證要做兩次。

## Consequences
- 安全邊界清楚、易測試、易稽核；Undo 可由 before/after 實作。
- Agent 無法在同一 run 內得知執行結果；需要時由使用者在 thread 再次 @bot，session 會帶到 ChangeSet 狀態。
