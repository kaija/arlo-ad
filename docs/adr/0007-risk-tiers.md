# ADR-0007：風險分級

- Status: Accepted
- Date: 2026-10-06
- Requirements: 4.1–4.6

## Context
熔斷、否定關鍵字需要即時自動；擴張性動作需要人審。

## Decision

| Tier | 定義 | 處理 |
|---|---|---|
| 0 | 只讀 | 不產生 ChangeSet |
| 1 | 保護性/減量（暫停、降預算、降出價目標、EXACT 否定字）且在門檻內 | 自動執行 + 通知 + Undo |
| 2 | 一般變更、所有擴張性動作 | 單人 approval |
| 3 | 超過 X% 或 $Y 的變更 | approval + 二次確認 + 四眼 |
| Hard block | validator HARD_BLOCK | 拒絕，不可 approve |

- `computeTier(changeSet, thresholds)` 為純函式；ChangeSet tier 取所有 op 最大值；WARN 違規至少提升至 Tier 2。
- 門檻由 admin 在 Web 設定。

## Consequences
- 熔斷不需等人；擴張性動作一律有人負責。
- tier 判定邏輯需要完整單元測試，避免誤判擴張為保護。
