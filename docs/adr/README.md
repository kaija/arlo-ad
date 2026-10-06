# Architecture Decision Records

設計決策紀錄。Spec 位於 [`.kiro/specs/arlo-ads-bot/`](../../.kiro/specs/arlo-ads-bot/)。
下表由 `node scripts/gen-adr-index.mjs` 依 requirements.md 的 `ADR:` 與 tasks.md 的 `_ADR:_` 標註產生，請勿手動編輯表格。

| ADR | 標題 | Requirements | Tasks |
|---|---|---|---|
| [ADR-0001](0001-single-org-internal-tool.md) | 單一組織內部工具 | R1 | 3.1 |
| [ADR-0002](0002-monorepo-nextjs-worker-pgboss.md) | TypeScript monorepo、Next.js web + Node worker、pg-boss | R7, R20 | 1.1, 1.2, 5.1, 8.2 |
| [ADR-0003](0003-postgres-scheduled-sync.md) | 定時同步廣告資料到 Postgres | R2, R18 | 3.2, 7.1, 7.2, 10.1, 10.2 |
| [ADR-0004](0004-platform-adapter.md) | PlatformAdapter — 共用核心 + 平台擴充 | R2 | 3.2, 6.1, 6.2, 12.1 |
| [ADR-0005](0005-chat-adapter.md) | 語意層 ChatAdapter，v1 只做 Slack | R7 | 7.2, 8.1, 8.2, 8.3 |
| [ADR-0006](0006-agent-proposes-executor-executes.md) | Agent 只產生 ChangeSet，決定性 Executor 執行 | R3 | 1.1, 11.1, 11.4, 12.2, 14.1, 14.2, 14.6, 19.3, 20.5 |
| [ADR-0007](0007-risk-tiers.md) | 風險分級 | R4 | 11.3, 12.2, 13.3, 14.3, 16.3 |
| [ADR-0008](0008-validator-typed-rules.md) | Validator 採固定規則型別 + 參數 | R5 | 11.2, 14.3, 19.4 |
| [ADR-0009](0009-approval-ttl-optimistic-revalidation.md) | Approval TTL + 執行前重驗（optimistic concurrency） | R6 | 12.3, 12.4, 13.3 |
| [ADR-0010](0010-identity-rbac.md) | Google Workspace SSO + Slack 身分對應 + RBAC | R1, R18 | 3.1, 4.1, 4.2, 4.3, 13.1, 14.2, 14.4 |
| [ADR-0011](0011-approval-routing.md) | Approval 路由 — 原 thread + approval channel 鏡像 | R7 | 13.2, 13.4 |
| [ADR-0012](0012-undo-time-window.md) | Undo — 24h 時間窗一鍵還原 + 漂移檢查 | R8 | 13.5 |
| [ADR-0013](0013-automation-modes-shadow.md) | 自動化模式 off / shadow / live | R9 | 15.1, 15.2, 17.2 |
| [ADR-0014](0014-agent-topology.md) | Orchestrator + agents-as-tools | R10 | 9.2, 9.3, 14.1, 18.4, 20.3 |
| [ADR-0015](0015-thread-session-context.md) | Thread = Session | R10 | 9.1, 9.4 |
| [ADR-0016](0016-scheduled-job-templates.md) | 排程 = Job 模板 + 可選 prompt | R11 | 9.5, 10.3, 14.6, 18.4 |
| [ADR-0017](0017-deterministic-monitor.md) | 決定性 Monitor 熔斷 + Agent 事後解釋 | R12 | 17.1, 17.2, 17.3, 17.4 |
| [ADR-0018](0018-budget-optimizer.md) | 預算再分配由演算法計算，Agent 審視與解釋 | R13 | 19.1, 19.2, 19.3, 19.4 |
| [ADR-0019](0019-negative-keywords-profile.md) | 否定關鍵字 — Business Profile + 硬性防護 | R14 | 16.1, 16.2, 16.3, 16.4, 21.1 |
| [ADR-0020](0020-campaign-agent-scope.md) | Campaign agent v1 — Search campaign、Draft、以 PAUSED 建立 | R15 | 20.1, 20.2, 20.3, 20.4, 20.5 |
| [ADR-0021](0021-tracking-audit-ads-ga4.md) | 成效審計 — Google Ads 診斷 + GA4 比對 | R16 | 18.1, 18.2, 18.3, 18.4 |
| [ADR-0022](0022-audience-analysis-only.md) | 受眾 v1 只做成效分析 | R17 | 21.2 |
| [ADR-0023](0023-model-tiering-llm-budget.md) | 分級模型 + LLM 成本上限 | R19 | 9.6, 16.2, 17.3 |
| [ADR-0024](0024-tracing-openai-default.md) | Tracing 使用 OpenAI 預設 + trace_id 連結 | R19 | 9.6 |
| [ADR-0025](0025-deploy-single-ec2-compose.md) | v1 部署 — 單台 EC2 + docker compose | R20 | 1.3, 2.1, 2.2, 2.3 |
| [ADR-0026](0026-dev-test-environment.md) | 開發與測試環境 | R20 | 1.4, 9.7, 12.1, 14.5 |
| [ADR-0027](0027-delivery-phasing.md) | 交付分期 — 先讀後寫、先骨幹後功能 | — | 全部（里程碑分組） |

## 慣例

- 新增 ADR：複製最近一份，編號遞增，Status 從 `Proposed` 開始；Accepted 後在 tasks.md 標註 `_ADR: ADR-XXXX_`，再重跑本腳本。
- 被取代：原 ADR 標記 `Superseded by ADR-XXXX`，不刪除。
