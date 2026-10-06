# ADR-0004：PlatformAdapter — 共用核心 + 平台擴充

- Status: Accepted
- Date: 2026-10-06
- Requirements: 2.7

## Context
從 Google Ads 開始，但未來可能接 Meta、TikTok 等。各平台概念差異大，完整統一抽象容易變成最小公分母。

## Decision
- 定義 `PlatformAdapter` 核心介面：帳戶、campaign、metrics、預算、狀態、變更歷史、`applyOps()`、`fetchCurrent()`。
- 平台特有能力（關鍵字、search terms、否定清單、tCPA/tROAS）放在平台擴充（`GoogleAdsExtensions`）與平台擴充表。
- ChangeSet op 命名：核心 op（`set_budget`、`set_status`）與平台 op（`google.add_negative_keyword`）。
- Validator 與預算規則只作用在核心欄位，跨平台通用。
- **原則：保留彈性為主；抽象困難時以 Google 為主，不為不存在的平台過度設計。**
- Google Ads 使用 `google-ads-api`（Opteo），官方 `google-ads-node` 無文件不採用。

## Consequences
- 新增平台 = 實作 adapter + 擴充表 + 平台專屬 tools。
- 部分 Google 專屬邏輯會直接存在於 Google 擴充，接受此耦合。
