# ADR-0017：決定性 Monitor 熔斷 + Agent 事後解釋

- Status: Accepted
- Date: 2026-10-06
- Requirements: 12.1–12.5

## Context
Google Ads 花費資料延遲數十分鐘到 3 小時；由 LLM 判斷熔斷慢且不穩定。

## Decision
- 每 15 分鐘（接在 snapshot sync 後）執行不含 LLM 的 Monitor。
- 規則型別：`SpendPacing{pct}`、`SpendNearCap{pct}`、`CpaSpike{hours, multiplier, minConv}`、`RoasDrop{hours, ratio, minConv}`。
- 觸發 → Tier 1 ChangeSet（action：pause / reduce_budget{pct} / reduce_target{pct}）→ Executor（遵守自動化模式）。
- 冷卻期：同 entity × 同規則預設 6h。
- 執行後非同步呼叫 Audit agent 產生根因，連同 [Undo] [維持] 發送。

## Consequences
- 反應時間下限 ≈ 資料延遲 + 15 分鐘，接受此限制。
- 誤判以 shadow 期間調參、Undo 緩解。
