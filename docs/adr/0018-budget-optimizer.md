# ADR-0018：預算再分配由演算法計算，Agent 審視與解釋

- Status: Accepted
- Date: 2026-10-06
- Requirements: 13.1–13.5

## Decision
- `packages/core/optimizer`：貪婪式邊際分配（以小額 step 逐次把預算給邊際轉換最高者），輸入：
  - 邊際 CPA/ROAS 估計：Google budget simulation（若有）> 近 14 天 cost/conv 曲線 > 平均值
  - lost IS (budget)、learning 狀態、資料量
- 約束：總額守恆、單次 |Δ| ≤ `maxChangePct`（預設 30%）、排除 learning / 轉換數不足。
- Bidding agent 只能排除 campaign、撰寫解釋，不得修改數字；最後 ChangeSet 至少 Tier 2。
- tCPA/tROAS 微調每次 ≤ ±15%，受 `BidTargetRange` 限制。

## Alternatives
- Agent 自行推理：數字品質不穩、無法解釋。
- 交給 Google shared budget：控制力低、無法跨平台。

## Consequences
- optimizer 可單元測試與回測；邊際估計品質受資料量限制。
