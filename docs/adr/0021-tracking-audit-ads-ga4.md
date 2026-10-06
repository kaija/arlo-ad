# ADR-0021：成效審計 — Google Ads 診斷 + GA4 比對

- Status: Accepted
- Date: 2026-10-06
- Requirements: 16.1–16.5

## Decision
- L1 Google Ads：conversion_action 狀態、最後轉換時間、Enhanced Conversions 診斷。
- L2 GA4 Data API（`@google-analytics/data`）：`sessionSourceMedium = google / cpc` 的轉換數 vs Ads 轉換，以 14 日基準計算落差偏移。
- 異常偵測：rolling median + MAD（robust z-score）於 clicks、CTR、CPC、CVR、geo、placement；並檢查「clicks↑ 但 GA4 sessions 不變」。
- Audit agent 關聯異常時間窗 ±48h 的 change_event 與 ChangeSet，輸出原因排序。
- 後端訂單 / CRM 對齊延至 v2。

## Consequences
- 需要 GA4 property 與 service account 權限。
- 統計門檻需在 shadow 期間調整。
