# ADR-0020：Campaign agent v1 — Search campaign、Draft、以 PAUSED 建立

- Status: Accepted
- Date: 2026-10-06
- Requirements: 15.1–15.8

## Decision
- Web 提交 brief → `campaign_tasks`（queued）→ worker 執行 Campaign agent。
- 產出：structure、ad groups、keywords + match types、RSA（≤15 headlines ≤30 字元、≤4 descriptions ≤90 字元）、negatives、budget/bidding 建議。
- `lintRsa()` 決定性檢查字元數（全形以 Google 規則計算）、重複、政策敏感字；不合格自動要求 agent 修正（最多 2 次）。
- Draft 可編輯、可局部重生；送出 → ChangeSet（≥ Tier 2）→ 以 `PAUSED` 建立；啟用為另一個 ChangeSet。
- 同步政策審核狀態回 Draft。

## Alternatives
- 含圖片 / PMax：工作量倍增，延至後續。
- 只產文件：自動化程度太低。

## Consequences
- 建立 campaign 是多 op ChangeSet（需處理 temporary resource name 與部分失敗）。
