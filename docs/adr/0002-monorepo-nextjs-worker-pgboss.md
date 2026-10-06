# ADR-0002：TypeScript monorepo、Next.js web + Node worker、pg-boss

- Status: Accepted
- Date: 2026-10-06
- Requirements: 7.7, 11.4, 15.1, 20.1

## Context
Slack 要求 3 秒內 ack，但 agent run 需數十秒、campaign task 需數分鐘；需要背景 worker 與 queue。語言限定 JS/TS。

## Decision
pnpm + turbo monorepo：

```
apps/web       Next.js (App Router)：UI、API、Slack endpoints（驗簽 → ack → enqueue）
apps/worker    Node 長駐程序：agents、executor、monitor、sync、scheduler
packages/core      domain types、ChangeSet、tier、validator、optimizer（純邏輯）
packages/db        Drizzle schema、migrations、repositories
packages/adapters  google-ads、ga4、slack（PlatformAdapter / ChatAdapter 實作）
packages/agents    openai-agents-js agent 與 tool 定義
```

Queue 與 cron 使用 **pg-boss**（只依賴 Postgres）。ORM 使用 Drizzle，schema 驗證使用 Zod。

## Alternatives
- Serverless（Lambda + SQS + EventBridge）：15 分鐘上限、本機體驗差。
- BullMQ + Redis：吞吐更好但多一個元件，內部流量不需要。

## Consequences
- 單一 Postgres 即可運行全部服務，利於 docker compose 部署（ADR-0025）。
- web 與 worker 可獨立擴展與搬遷。
