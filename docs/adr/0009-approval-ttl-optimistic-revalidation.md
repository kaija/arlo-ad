# ADR-0009：Approval TTL + 執行前重驗（optimistic concurrency）

- Status: Accepted
- Date: 2026-10-06
- Requirements: 6.1–6.6

## Context
提議與 approve 之間，帳戶可能被人在 Google Ads UI 修改，或花費已變化。

## Decision
- ChangeSet 記錄每個 op 的 `before`（提議當下值）與 `expires_at`（預設 24h，熔斷類較短）。
- Approve 時重新 fetch：任一 op 現況 ≠ `before` → `STALE`，通知重新提議。
- 重驗通過後以最新 context 重跑 validator，再 mutate。
- Approval 以 `(changeset_id, status)` 條件更新達成冪等。

## Alternatives
- 只設 TTL：可能蓋掉手動變更。
- 相對值 op（+50%）：approver 看到的數字與實際執行不同。

## Consequences
- 偶爾需要重新提議，但不會蓋掉人工變更。
