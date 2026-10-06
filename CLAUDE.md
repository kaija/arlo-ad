# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案狀態

Arlo Ads Bot：內部用的 Google Ads 管理 Agent 系統（Slack + Web console）。目前只有 spec 與 ADR，**尚未有程式碼**；實作依 `.kiro/specs/arlo-ads-bot/tasks.md` 逐步進行。建立 monorepo（task 1.1）後，請在本檔補上實際的 build / lint / test 指令。

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
- **以 eslint `no-restricted-imports` 強制的邊界**：
  - `packages/core` 不得 import 任何 I/O 套件。
  - `PlatformAdapter.applyOps` 只能由 `apps/worker/src/handlers/executor.ts` 呼叫。
  - `packages/agents` 不得 import platform adapter 的 mutate 介面。
- **抽象層**：`PlatformAdapter`（共用核心 + Google 擴充，ADR-0004）與 `ChatAdapter`（語意訊息，v1 只做 Slack，ADR-0005），皆有 Fake 實作供整合測試使用。
- **寫入白名單（ADR-0026）**：mutate 前必須 `assertWriteAllowed()` 檢查 `ADS_WRITE_ALLOWED_CUSTOMER_IDS`；dev 只放測試帳戶。新自動化功能預設 shadow 模式（ADR-0013）。
- **測試分層**：單元（core 純函式，table-driven，覆蓋率 ≥ 90%）、整合（Testcontainers + Fake adapters）、Contract（Google Ads 測試帳戶，手動 `pnpm test:contract`）、Agent eval（`evals/` golden set）、E2E（Slack payload → EXECUTED）。
- **部署**：單台 EC2 + docker compose（Caddy、web、worker、postgres），見 ADR-0025。
