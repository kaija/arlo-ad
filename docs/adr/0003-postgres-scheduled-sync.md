# ADR-0003：定時同步廣告資料到 Postgres

- Status: Accepted
- Date: 2026-10-06
- Requirements: 2.1–2.8, 18.1, 18.2

## Context
Web 圖表、異常偵測、變更歷史關聯都需要歷史資料；Google Ads `change_event` 只保留 30 天，即時 GAQL 查詢慢且耗 quota。

## Decision
Sync worker 以排程把資料拉進 Postgres：

| 頻率 | 內容 |
|---|---|
| 每 15 分鐘 | change_event、campaign 預算/狀態/出價目標 snapshot |
| 每小時 | 當日 metrics（account / campaign / ad group / keyword） |
| 每日 | D-3..D-1 metrics 重拉（轉換回補）、search terms、conversion actions、user lists |

Web 與 agent 讀 Postgres；只有 Executor 執行前重驗會即時查 API。

## Alternatives
- 全部即時查 API：實作最少，但慢、耗 quota、沒有長期歷史。
- BigQuery Data Transfer：只有日粒度、綁定 GCP。

## Consequences
- 資料最多延遲約 1 小時（metrics）/ 15 分鐘（狀態）；Monitor 的反應速度以此為下限。
- 需要處理 upsert 冪等與回補覆寫。
