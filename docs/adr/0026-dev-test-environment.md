# ADR-0026：開發與測試環境

- Status: Accepted
- Date: 2026-10-06
- Requirements: 20.9

## Context
已有 Basic/Standard developer token，可讀取正式帳戶。

## Decision
- `ADS_WRITE_ALLOWED_CUSTOMER_IDS` 環境變數：Executor mutate 前強制檢查 customer id 在白名單；dev 只放測試帳戶。
- dev 可唯讀同步正式帳戶資料；正式帳戶的自動化一律從 shadow 開始（ADR-0013）。
- 測試分層：
  - 單元（Vitest）：validator、tier、optimizer、lint、monitor、ChangeSet 狀態機。
  - 整合（Testcontainers Postgres）：repositories、Executor、pg-boss handlers；PlatformAdapter 以 fake 實作。
  - Contract：Google Ads 測試帳戶 e2e（手動觸發）。
  - Agent eval：golden set（search term 分類、tier 路由、異常解釋），在 CI 跑小樣本。

## Consequences
- 寫入白名單是 dev 誤寫正式帳戶的最後防線。
