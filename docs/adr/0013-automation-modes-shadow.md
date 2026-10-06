# ADR-0013：自動化模式 off / shadow / live

- Status: Accepted
- Date: 2026-10-06
- Requirements: 9.1–9.5

## Decision
- `automation_modes(account_id, feature, mode)`；feature ∈ `negative_kw_auto`、`circuit_breaker`、`bid_auto_reduce`、`budget_rebalance`。
- 新帳戶預設 `shadow`。
- shadow：Executor 跑完 validator 與 tier，不 mutate，狀態 `SIMULATED`，發送「若 live 會做 X」+ 👍/👎。
- Web 顯示 shadow 準確率；只有 admin 可切換。
- Shadow 判定點在 Executor 的 mutate 前一步，確保 shadow 與 live 走同一條程式路徑。

## Consequences
- 可逐帳戶、逐功能建立信任。
- 需要收集與呈現回饋資料。
