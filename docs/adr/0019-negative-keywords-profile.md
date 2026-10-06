# ADR-0019：否定關鍵字 — Business Profile + 硬性防護

- Status: Accepted
- Date: 2026-10-06
- Requirements: 14.1–14.7

## Decision
- 每帳戶 `business_profiles`（版本化）：offerings、target_intents、excluded_intents、brand_terms、competitor_policy、examples。
- 小模型批次分類（100 筆/批，structured output），結果以 `(term_hash, profile_version)` 快取。
- 自動（Tier 1）條件：`confidence ≥ 0.9 ∧ conv_90d = 0 ∧ ¬brand ∧ cost > 0` → EXACT match → shared list `arlo-auto-negatives`。
- 其餘不相關 → Tier 2 批次 ChangeSet，可逐項勾選；被剔除項目回寫 profile examples。
- 關鍵字擴展：search terms 挖掘 + `KeywordPlanIdeaService`，一律 Tier 2。

## Consequences
- Profile 品質決定分類品質；需在 Web 提供編輯與範例管理。
- 專用 shared list 讓自動否定可整批回滾。
