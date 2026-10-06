# ADR-0022：受眾 v1 只做成效分析

- Status: Accepted
- Date: 2026-10-06
- Requirements: 17.1–17.3

## Decision
- v1 同步 user lists 與受眾區隔成效，agent 可提出 bid modifier / exclusion ChangeSet（Tier 2）。
- Customer Match 上傳（PII、SHA-256、OfflineUserDataJob）延至 v2，待確認資料來源。

## Consequences
- v1 不處理任何 PII。
