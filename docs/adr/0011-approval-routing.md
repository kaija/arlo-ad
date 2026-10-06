# ADR-0011：Approval 路由 — 原 thread + approval channel 鏡像

- Status: Accepted
- Date: 2026-10-06
- Requirements: 7.1–7.5

## Decision
- 來源為對話 → approval 卡片發在原 thread。
- 來源為排程/monitor → 發到排程目標 channel（預設 `#ads-approvals`）。
- 原 thread 不在 approval channel → 另發鏡像卡片並附 permalink。
- 卡片關聯存於 `approval_messages`；任一張被操作，全部以 `chat.update` 同步。
- SLA（預設 2h）未處理 → 在 approval channel 提醒具資格 approver。

## Alternatives
- 只在原 thread：approver 不在 channel 會卡住。
- DM approver：吵且失去公開脈絡。

## Consequences
- 需要追蹤每個 ChangeSet 的多個訊息位置。
