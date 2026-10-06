# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案狀態

Arlo Ads Bot：內部用的 Google Ads 管理 Agent 系統（Slack + Web console）。實作依 `.kiro/specs/arlo-ads-bot/tasks.md` 逐步進行。

## 指令

Node 24（`.node-version`）、pnpm 11（`packageManager`）。

```bash
pnpm install
pnpm lint                     # eslint（含 package 邊界規則）
pnpm typecheck                # root tsc + turbo 跑各 package 的 tsc
pnpm test                     # vitest，全部 projects
pnpm vitest run packages/core/src/tier/tier.test.ts   # 單一測試檔
pnpm vitest run --project @arlo/core                  # 單一 package
pnpm build                    # turbo build（目前只有 apps/web）
pnpm dev                      # turbo dev
```

- Workspace package（`@arlo/*`）直接 export TypeScript 原始碼（`exports: ./src/index.ts`），沒有個別 build 步驟；`apps/web` 以 `transpilePackages` 編譯。新增被 web 使用的 package 時要加進 `apps/web/next.config.ts`。
- 共用版本放在 `pnpm-workspace.yaml` 的 `catalog:`。
- typescript 固定 `~6.0`：typescript-eslint 尚未支援 TS 7。
- pnpm 啟用 minimumReleaseAge；不要為了裝剛發布的版本而加入 `minimumReleaseAgeExclude`，改用前一個已過門檻的版本。
- Vitest projects：每個 `apps/*`、`packages/*`、`evals` 各為一個 project（以 package name 命名）；repo 層級測試在 `tests/`（project `repo`）。
- DB 整合測試 harness（`@arlo/db/testing`，**需要 Docker daemon 在執行**）：project 的 `vitest.config.ts` 加 `globalSetup: ['@arlo/db/testing/global-setup']`（每次測試啟動一個 `postgres:18-alpine` container，migrations 套用到 template DB），測試檔呼叫 `const t = useTestDatabase()` 取得從 template 複製的獨立 database（`t.db` Drizzle、`t.pool`、`t.url`）。需要空 DB 時用 `{ migrated: false }`。隔離單位是 database 而非 schema，因為 drizzle-kit 產生的 SQL 帶 `"public".`。沒有設 globalSetup 的 project（core、config）不需要 Docker。
- 安裝腳本預設拒絕：新依賴若出現 `ERR_PNPM_IGNORED_BUILDS`，在 `pnpm-workspace.yaml` 的 `allowBuilds` 明確設 `true`/`false`（只有真的需要時才設 `true`）。
- 本機執行 worker：`DATABASE_URL=... pnpm --filter @arlo/worker dev`（health 在 `WORKER_HEALTH_PORT`，預設 9090）。
- DB migration：schema 在 `packages/db/src/schema/`，產生 migration 用 `pnpm --filter @arlo/db db:generate`（輸出到 `packages/db/migrations/`），套用用 `DATABASE_URL=... pnpm --filter @arlo/worker migrate`；在 image 內為 `docker compose -f docker-compose.prod.yml run --rm worker migrate`。`runMigrations` 從 `@arlo/db/migrate` 匯入（不在 `@arlo/db` 主入口，避免 web bundle 進 migrations 目錄）。
- 部署（EC2 上）：`scripts/deploy.sh`（git pull → build → migrate → `up -d --wait`；失敗印 log 並非零退出）；`--no-pull` 部署目前工作目錄。
- 備份 / 還原：`scripts/backup.sh`（cron 每日；`pg_dump -Fc` → gzip → 驗證 → S3，失敗發 `SLACK_OPS_WEBHOOK_URL`）、`scripts/restore.sh <key> [--yes]`（先還原到暫存 DB，成功才停 web/worker 並以 rename 交換，舊 DB 保留為 `<db>_pre_restore_<ts>`）。30 天保留靠 `infra/s3/backup-lifecycle.json` 的 S3 lifecycle rule。共用 helper 在 `scripts/lib/pg-ops.sh`（`PG_EXEC`、`AWS_CLI`、`ENV_FILE` 可覆寫，供 `tests/backup-restore.test.ts` 使用）。Shell script 以 `shellcheck -x` 檢查，並用 `set -Eeuo pipefail`（ERR trap 才會在函式內觸發）。
- 全套本機環境（postgres + web + worker，熱重載）：`docker compose up --build --watch`；環境變數範本在 `.env.example`（新增變數時同步更新）。

## Docker

- `infra/docker/Dockerfile.{web,worker}`，build context 為 repo 根目錄；target `dev`（compose 用）與 `runtime`（預設，non-root `node` 使用者）。
- 兩者都以 `turbo prune --docker` 只帶入需要的 workspace package；prune 不含根目錄 `tsconfig.base.json`，Dockerfile 另外 COPY。新增根目錄共用檔案時要檢查是否也需要 COPY。
- Production：`docker-compose.prod.yml`（project name `arlo`；caddy、web、worker、postgres）。只有 Caddy 對外開 80/443；`DATABASE_URL` 由 compose 以 `POSTGRES_PASSWORD` 組成（需 URL-safe）；Postgres 資料在 `${PG_DATA_DIR:-/data/pg}`。本機驗證可用 `APP_DOMAIN=localhost`（Caddy 內部 CA）與 scratch 目錄的 `PG_DATA_DIR`。
- worker runtime 以 `node --import tsx` 直接跑 TS 原始碼（`tsx` 是 worker 的 production dependency）；web 用 Next.js `output: 'standalone'`。若之後新增 `apps/web/public/`，要在 Dockerfile.web runtime stage 補 COPY。

## 慣例

- 資料表：每張表都有 `org_id`（Requirement 1.7），v1 寫入一律用 `DEFAULT_ORG_ID`（由 migration `0001_seed_default_org` 建立，無 DB default）；主鍵 `uuidv7()`；`created_at` / `updated_at`（`updated_at` 只在 Drizzle update 時自動更新）。共用欄位 helper 在 `packages/db/src/schema/columns.ts`。資料語意盡量用 CHECK constraint 固定（例：`users.status` 與 `slack_user_id` 一致、email 小寫）。
- 平台資料（`packages/db/src/schema/platform.ts`）：`platform` 只存在 `ad_accounts`；`entities.external_id` 在 (account, kind) 內唯一（Google keyword 用 `adGroupId~criterionId`）；帳戶層級 metrics 用 kind=`account` 的 entity。`metrics_*` 的 `account_id`/`level` 是反正規化欄位，由複合 FK 對應 entity。金額一律 micros（bigint），比例 0–1。
- 同步寫入走 `packages/db/src/repositories/platform.ts` 的 upsert 函式：metrics / 報表衝突時覆寫（回補）、snapshot 與 change_events 只插入不改；自動分批避開 bind parameter 上限；同一次呼叫內 row 不可重複 conflict key。

- 環境變數一律經 `@arlo/config` 的 `parseEnv(EnvSchema.pick({...}))` 讀取，不直接讀 `process.env`。每個 process 只 pick 自己用到的 key，功能落地時再擴充 pick（`apps/worker/src/index.ts` 的 `WorkerEnv`、`apps/web/lib/server.ts` 的 `WebEnv`）。新增變數時同時改 `EnvSchema` 與 `.env.example`（`env.test.ts` 會檢查兩者一致）；錯誤訊息只列 key，不可帶出值。
- 寫入廣告帳戶前必須呼叫 `assertWriteAllowed(env.ADS_WRITE_ALLOWED_CUSTOMER_IDS, customerId)`（ADR-0026）；空白清單代表不允許任何寫入。

- Log 一律用 `@arlo/config/logger` 的 `createLogger({ component })`，追蹤欄位以 `logger.child({ changeset_id, job_id, trace_id })` 帶入；錯誤用 `{ err }` 欄位（序列化時會移除 pg `client` 等連線物件）。秘密與 email 依 key 名遮罩，新增敏感欄位時擴充 `SECRET_KEYS`。
- Healthz 回應是公開的：失敗只回錯誤代碼（`ECONNREFUSED`、SQLSTATE、`timeout`），細節寫 log。新增檢查項（pg-boss、last sync）時加進 web 與 worker 的 `runHealthChecks({...})`。

## 文件位置

| 用途 | 路徑 |
|---|---|
| 需求（EARS，`### Requirement N` + 編號驗收條件，每條標 `ADR:`） | `.kiro/specs/arlo-ads-bot/requirements.md` |
| 設計（架構、流程、介面、資料模型、錯誤處理、測試策略） | `.kiro/specs/arlo-ads-bot/design.md` |
| **任務清單（task management）** | `.kiro/specs/arlo-ads-bot/tasks.md` |
| 架構決策 ADR | `docs/adr/NNNN-*.md` |
| ADR 索引（自動產生，勿手改表格） | `docs/adr/README.md` |

## 任務執行流程（tasks.md）

依任務順序執行，並在 tasks.md 中更新狀態：

1. **選任務**：從上到下找第一個未完成的子任務（如 `1.1`）。里程碑 M0 → M4 依序進行（ADR-0027），不跳過前置任務；若使用者指定特定任務則以使用者為準。
2. **開始前**：閱讀該任務的 `_Requirements_`（requirements.md 對應驗收條件）與 `_ADR_`（docs/adr/ 對應檔），以及 design.md 相關段落。
3. **標記進行中**：開始時把子任務改為 `- [-]`；若父任務仍為 `- [ ]` 也改為 `- [-]`。
4. **實作與驗證**：完成任務描述中的所有項目，包含其中列出的測試；測試通過才算完成。
5. **標記完成**：子任務改為 `- [x]`；父任務的所有子任務都 `[x]` 時，父任務也改為 `- [x]`。
6. **回報**：每完成一個子任務，簡述完成內容與測試結果，再進行下一個。遇到 spec 不清楚或需要偏離設計時，先停下來詢問。

狀態符號：`[ ]` 未開始、`[-]` 進行中、`[x]` 完成。只改勾選框，不要改動任務文字與 `_Requirements_` / `_ADR_` 標註（索引腳本依賴這些格式）。

## ADR 慣例

- 新增 ADR：複製最近一份、編號遞增、Status 從 `Proposed` 開始；Accepted 後在 tasks.md 加 `_ADR: ADR-XXXX_`、在 requirements.md 加 `ADR:`。
- 被取代的 ADR 標 `Superseded by ADR-XXXX`，不刪除。
- 修改 tasks.md 或 requirements.md 的標註後，重新產生索引：

```bash
node scripts/gen-adr-index.mjs
```

此腳本同時檢查「沒有任務涵蓋的驗收條件」與「沒有任務的 ADR」，有任一項時以非零 exit code 結束。

## 架構重點（詳見 design.md）

- **兩個 process，一個 Postgres**：`apps/web`（Next.js App Router：UI、API、Slack endpoints 驗簽 → 3 秒內 ack → enqueue）與 `apps/worker`（agents、Executor、Monitor、Sync、Scheduler）。Postgres 同時承載資料、pg-boss queue/cron、agent sessions。pnpm + turbo monorepo，Drizzle + Zod，Vitest + Testcontainers。
- **核心安全邊界（ADR-0006）**：Agent（`@openai/agents`）只能呼叫 read tools 與 `propose_*` tools，後者只建立 ChangeSet；唯一能呼叫廣告平台 mutate 的是不含 LLM 的 Executor：`validator → tier → approval → re-fetch & diff → mutate → audit_log`。所有金錢相關決定（擋下、是否需審、數字、熔斷、預算分配）都必須是 `packages/core` 中可單元測試的純函式，不可交給 LLM。
- **以 eslint 強制的邊界**（`eslint.config.mjs`，由 `tests/eslint-boundaries.test.ts` 驗證；改規則時同步更新該測試）：
  - `packages/core` 只能 import 相對路徑與 `zod`（allowlist），且禁用 `process` / `fetch`；其 tsconfig `types: []` 讓 Node 型別無法通過型別檢查。新增純邏輯依賴時須擴充 allowlist。
  - `applyOps` 這個識別字只能出現在 `packages/adapters/**` 與 `apps/worker/src/handlers/executor.ts`（及其測試）。
  - `packages/agents` 不得 import `@arlo/adapters` / `@arlo/adapters/platform*`。
  - `google-ads-api` 只能在 `packages/adapters` 使用。
- **抽象層**：`PlatformAdapter`（共用核心 + Google 擴充，ADR-0004）與 `ChatAdapter`（語意訊息，v1 只做 Slack，ADR-0005），皆有 Fake 實作供整合測試使用。
- **寫入白名單（ADR-0026）**：mutate 前必須 `assertWriteAllowed()` 檢查 `ADS_WRITE_ALLOWED_CUSTOMER_IDS`；dev 只放測試帳戶。新自動化功能預設 shadow 模式（ADR-0013）。
- **測試分層**：單元（core 純函式，table-driven，覆蓋率 ≥ 90%）、整合（Testcontainers + Fake adapters）、Contract（Google Ads 測試帳戶，手動 `pnpm test:contract`）、Agent eval（`evals/` golden set）、E2E（Slack payload → EXECUTED）。
- **部署**：單台 EC2 + docker compose（Caddy、web、worker、postgres），見 ADR-0025。
