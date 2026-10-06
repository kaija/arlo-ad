# ADR-0015：Thread = Session

- Status: Accepted
- Date: 2026-10-06
- Requirements: 10.1–10.4, 10.6

## Decision
- thread 內 @：讀整個 thread（超過上限取首則 + 最後 20 則）。
- 主線 @：讀前 10 則主線訊息，以新 thread 回覆。
- `session_id = slack:{channel}:{thread_ts}`，實作 SDK `Session` 介面的 `PgSession`，存 agent items（含 tool calls/results）。
- 再次 @ 時只差量補入上次之後的 Slack 訊息（標為其他參與者發言）。
- 執行中先加 reaction（⏳），完成後回覆並移除。

## Consequences
- 長 thread 的 session 需要截斷策略（保留最近 N 個 items + 摘要）。
- Slack 訊息內容是不可信輸入，仍受 ADR-0006 保護。
