# ADR-0027：交付分期 — 先讀後寫、先骨幹後功能

- Status: Accepted
- Date: 2026-10-06

## Decision

| 里程碑 | 內容 |
|---|---|
| M0 基礎 | monorepo、compose、DB、auth、EC2 部署腳本 |
| M1 看得到 | sync、dashboard、@bot 問數、daily report |
| M2 安全地改 | ChangeSet、Executor、validator、tier、RBAC、approval、audit、undo |
| M3 自動化 | shadow 模式、否定關鍵字、Monitor 熔斷、tracking audit、anomaly |
| M4 優化創作 | budget optimizer、tCPA/tROAS、campaign agent、keyword expansion、受眾分析 |

每個里程碑可獨立使用。

## Consequences
- 寫入能力在 M2 才出現，M1 期間 bot 只讀，風險最低。
