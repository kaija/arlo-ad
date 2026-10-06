# Requirements Document

## Introduction

Arlo Ads Bot 是一套內部使用的廣告帳戶管理 Agent 系統，從 Google Ads 開始，架構保留擴充到其他廣告平台（Meta、TikTok…）與其他 chat service（Teams…）的彈性。

系統透過 Slack 與 Web console 兩個入口運作：

- 讀取廣告帳戶現況（花費、成效、追蹤健康度），並以排程或對話方式回報。
- 由多個專業 Agent（OpenAI Agents SDK for JS）提出變更建議；所有寫入動作皆轉為 **ChangeSet**，由不含 LLM 的決定性 **Executor** 經過 validator、風險分級、approval、執行前重驗後才寫入廣告平台。
- 涵蓋關鍵字與受眾管理、出價與預算調控、成效審計與歸因、Campaign 內容產生四大領域。

技術邊界：TypeScript monorepo（Next.js web + Node worker）、Postgres、pg-boss；v1 部署於單台 EC2 以 docker compose 運行。

設計決策記錄於 `docs/adr/`，每條需求標註對應 ADR。

### 名詞

| 名詞 | 定義 |
|---|---|
| ChangeSet | 一組對廣告平台的寫入操作（ops），帶 before/after、tier、狀態、來源 |
| Executor | 不含 LLM 的服務，唯一可以呼叫廣告平台 mutate API 的元件 |
| Tier | 風險等級：0 只讀、1 保護性自動、2 單人 approval、3 approval + 二次確認 |
| Hard block | validator 判定違反 HARD_BLOCK 規則，任何人都無法 approve |
| ConversationRef | 平台無關的對話位置 `{platform, channelId, threadId}` |
| Automation mode | 每帳戶 × 每自動化功能的模式：`off` / `shadow` / `live` |
| Business Profile | 帳戶層級的業務描述，用於搜尋意圖分類 |

---

## Requirements

### Requirement 1：身分、登入與 RBAC

**User Story:** 身為 admin，我想要用公司 Google 帳號登入 Web，並把 Slack 身分對應到角色，讓 Slack 與 Web 的權限一致且可稽核。

ADR: ADR-0001, ADR-0010

#### Acceptance Criteria

1. WHEN 使用者存取 Web console THEN 系統 SHALL 要求以 Google Workspace SSO 登入，且僅允許設定的 Workspace domain。
2. WHEN 使用者首次登入 THEN 系統 SHALL 以 email 呼叫 Slack `users.lookupByEmail` 自動綁定 `slack_user_id`。
3. IF email 無法對應 Slack 使用者 THEN 系統 SHALL 將使用者標記為「未綁定」並允許 admin 手動綁定。
4. 系統 SHALL 支援 `viewer` / `operator` / `approver` / `admin` 四種角色，且每個 role binding 可限定 ad account 範圍與最高可 approve 的 tier。
5. WHEN 任何 Slack 互動（按鈕、指令）抵達 THEN 系統 SHALL 以 `slack_user_id` 解析內部使用者並驗證權限；未綁定或無權限者 SHALL 收到 ephemeral 拒絕訊息。
6. IF ChangeSet tier = 3 THEN 系統 SHALL 拒絕發起人自己 approve（四眼原則）。
7. 系統 SHALL 在所有資料表保留 `org_id` 欄位，v1 僅存在單一 org。

### Requirement 2：廣告資料同步

**User Story:** 身為行銷人員，我想要 Web 與 Bot 讀到快速且有歷史的數據，以便看趨勢與比對變更。

ADR: ADR-0003, ADR-0004

#### Acceptance Criteria

1. 系統 SHALL 每小時同步當日 account / campaign / ad group / keyword 層級 metrics 到 Postgres。
2. 系統 SHALL 每日重拉 D-3 至 D-1 的 metrics，以涵蓋轉換回補。
3. 系統 SHALL 每 15 分鐘同步 `change_event` 與 campaign 預算/狀態/出價目標 snapshot。
4. 系統 SHALL 每日同步 search term 報表。
5. 系統 SHALL 永久保存同步過的 change_event（超過 Google Ads 30 天上限）。
6. WHEN 同步失敗 THEN 系統 SHALL 以指數退避重試，連續失敗超過門檻 SHALL 發送 Notice 到 ops channel。
7. 平台資料 SHALL 以正規化 schema 儲存（`platform`, `account`, `entity`, `date`, metrics），平台特有資料存於平台擴充表。
8. Agent 與 Web 讀取 SHALL 走 Postgres；僅 Executor 重驗時即時呼叫平台 API。

### Requirement 3：ChangeSet 與 Executor

**User Story:** 身為 admin，我想要所有寫入都經過一條決定性的管線，讓 LLM 的錯誤或 prompt injection 無法繞過防護。

ADR: ADR-0006

#### Acceptance Criteria

1. Agent tools SHALL NOT 直接呼叫任何廣告平台 mutate API；寫入類 tool SHALL 只建立 ChangeSet。
2. 每個 ChangeSet op SHALL 記錄 target entity、欄位、`before`（提議當下值）與 `after`。
3. WHEN ChangeSet 建立 THEN Executor SHALL 依序執行：validator → tier 判定 → （依 tier）approval → 執行前重驗 → mutate → 稽核紀錄。
4. 系統 SHALL 以狀態機管理 ChangeSet：`PENDING_VALIDATION`、`BLOCKED`、`PENDING_APPROVAL`、`APPROVED`、`EXECUTING`、`EXECUTED`、`FAILED`、`REJECTED`、`STALE`、`EXPIRED`、`SIMULATED`、`REVERTED`。
5. WHEN mutate 部分失敗 THEN Executor SHALL 記錄每個 op 的結果並將 ChangeSet 標記 `FAILED` 且保留已成功 op 的資訊。
6. 每次狀態轉換 SHALL 寫入 append-only 的 audit log（actor、時間、前後狀態、原因）。
7. ChangeSet SHALL 記錄來源（chat / schedule / monitor / web / undo）與 OpenAI `trace_id`（若有）。

### Requirement 4：風險分級

**User Story:** 身為 admin，我想要保護性動作可以自動執行、擴張性動作需要 approval，讓熔斷不必等人。

ADR: ADR-0007

#### Acceptance Criteria

1. Tier 0（只讀）SHALL 不產生 ChangeSet。
2. 系統 SHALL 將「保護性/減量」op（暫停、降低預算、降低出價目標、新增 exact 否定關鍵字）在符合 admin 設定門檻時判定為 Tier 1，並自動執行。
3. 系統 SHALL 將「擴張性」op（提高預算、提高出價目標、啟用、新增 campaign/關鍵字）判定為至少 Tier 2。
4. IF ChangeSet 變動金額或比例超過 admin 設定的 Tier 3 門檻（X% 或 $Y）THEN 系統 SHALL 判定為 Tier 3。
5. ChangeSet 的 tier SHALL 取其所有 op 中最高者。
6. WHEN Tier 1 執行完成 THEN 系統 SHALL 發送含 diff 與 Undo 按鈕的通知。

### Requirement 5：Validator 與預算上限

**User Story:** 身為 admin，我想要設定預算上限與變更規則，讓超出合理範圍的動作被硬性擋下。

ADR: ADR-0008

#### Acceptance Criteria

1. 系統 SHALL 提供以下規則型別：`DailyBudgetCap{max}`、`MonthlySpendCap{max}`、`MaxChangePct{pct, window}`、`BidTargetRange{min, max}`、`MaxMutationsPerDay{n}`。
2. 每條規則實例 SHALL 有 scope（org / account / campaign）與 severity（`HARD_BLOCK` / `WARN`），較窄 scope 覆寫較寬 scope。
3. IF 任一 `HARD_BLOCK` 規則違反 THEN 系統 SHALL 將 ChangeSet 標記 `BLOCKED` 並通知來源對話，且不提供 approve 按鈕。
4. IF 僅 `WARN` 規則違反 THEN 系統 SHALL 在 approval 卡片顯示警告並將 tier 至少提升到 2。
5. `MonthlySpendCap` SHALL 以當月實際花費 + 剩餘天數 × 新日預算估算。
6. Validator SHALL 為純函式（輸入 ChangeSet + context，輸出 violations），並具備單元測試。

### Requirement 6：Approval 生命週期

**User Story:** 身為 approver，我想要 approve 的內容在執行時仍然正確，避免覆蓋別人的手動變更。

ADR: ADR-0009

#### Acceptance Criteria

1. 每個待 approval 的 ChangeSet SHALL 有 `expires_at`（預設 24h，可依 op 類型設定）。
2. WHEN 超過 `expires_at` THEN 系統 SHALL 標記 `EXPIRED` 並以 `chat.update` 停用卡片按鈕。
3. WHEN approver 按下 Approve THEN Executor SHALL 重新抓取目標 entity 現況；IF 任一 op 的現況 ≠ `before` THEN SHALL 標記 `STALE` 並通知來源對話重新提議。
4. WHEN 重驗通過 THEN Executor SHALL 以最新 context 重跑 validator，通過才 mutate。
5. WHEN approver 按下 Reject THEN 系統 SHALL 標記 `REJECTED` 並可附原因。
6. 同一 ChangeSet 的 approval 操作 SHALL 具冪等性（重複點擊只處理一次）。

### Requirement 7：Approval 路由與 Slack 互動

**User Story:** 身為 approver，我想要在 approval channel 看到所有待審事項，即使請求發生在我不在的 channel。

ADR: ADR-0002, ADR-0005, ADR-0011

#### Acceptance Criteria

1. WHEN ChangeSet 來源為對話 THEN 系統 SHALL 在來源 thread 發送 approval 卡片。
2. WHEN ChangeSet 來源為排程或 monitor THEN 系統 SHALL 發送到該排程設定的目標 channel（預設 approval channel）。
3. IF 來源 thread 不在 approval channel THEN 系統 SHALL 另在 approval channel 發送鏡像卡片並附來源 thread 連結。
4. WHEN 任一張卡片被操作 THEN 系統 SHALL 同步更新所有關聯卡片顯示結果與操作者。
5. WHEN ChangeSet 超過 SLA（預設 2h）仍未處理 THEN 系統 SHALL 在 approval channel 提醒具資格的 approver。
6. 核心模組 SHALL 只輸出語意訊息（`ApprovalRequest`、`Report`、`Notice`），由 `ChatAdapter` 渲染；v1 僅實作 Slack adapter。
7. Slack endpoint SHALL 驗證 signing secret，並在 3 秒內 ack，實際處理放入 queue。

### Requirement 8：Undo

**User Story:** 身為 operator，我想要一鍵還原自動執行的動作，但不想蓋掉同事後來的手動調整。

ADR: ADR-0012

#### Acceptance Criteria

1. WHEN ChangeSet 狀態為 `EXECUTED` 且執行時間在 24h 內 THEN 系統 SHALL 在通知卡片與 Web 提供 Undo。
2. Undo SHALL 僅允許 `operator` 以上且 scope 涵蓋該帳戶的使用者。
3. WHEN Undo 觸發 THEN 系統 SHALL 重新抓取現況；IF 現況 = 原 ChangeSet 的 `after` THEN SHALL 直接寫回 `before`，不經 validator 與 approval。
4. IF 現況 ≠ `after` THEN 系統 SHALL 拒絕 Undo 並顯示目前值與最後修改者（若可從 change_event 得知）。
5. Undo SHALL 產生一筆 `revert_of` 指向原 ChangeSet 的新 ChangeSet，原 ChangeSet 標記 `REVERTED`。

### Requirement 9：自動化模式（shadow）

**User Story:** 身為 admin，我想要先觀察自動化的判斷是否正確，再逐帳戶、逐功能開啟。

ADR: ADR-0013

#### Acceptance Criteria

1. 系統 SHALL 為每個 account × 自動化功能（`negative_kw_auto`、`circuit_breaker`、`bid_auto_reduce`、`budget_rebalance`）維護模式 `off` / `shadow` / `live`。
2. 新帳戶的所有自動化 SHALL 預設為 `shadow`。
3. WHILE 模式為 `shadow` Executor SHALL 完整執行 validator 與 tier 判定，但 SHALL NOT mutate，ChangeSet 標記 `SIMULATED`。
4. WHEN 產生 `SIMULATED` ChangeSet THEN 系統 SHALL 發送「若為 live 會執行 X」訊息與 👍/👎 回饋按鈕。
5. Web SHALL 顯示每個功能的 shadow 準確率，並僅允許 admin 切換模式。

### Requirement 10：Slack 對話與上下文

**User Story:** 身為行銷人員，我想要在 Slack @bot 問問題或下指令，bot 能理解討論脈絡並記得這個 thread 先前做過的事。

ADR: ADR-0014, ADR-0015

#### Acceptance Criteria

1. WHEN bot 在 thread 內被 @ THEN 系統 SHALL 讀取該 thread 訊息（超過上限時取首則 + 最後 20 則）作為上下文。
2. WHEN bot 在 channel 主線被 @ THEN 系統 SHALL 讀取主線前 10 則訊息，並以新 thread 回覆。
3. 系統 SHALL 以 `slack:{channel}:{thread_ts}` 為 key 建立 SDK Session 存於 Postgres，保存 agent 的 tool calls 與結果。
4. WHEN 同 thread 再次被 @ THEN 系統 SHALL 只將上次之後的新 Slack 訊息以「其他參與者發言」差量補入 session。
5. 所有對話請求 SHALL 進入 Orchestrator agent，由其以 agents-as-tools 呼叫專業 agent。
6. WHEN agent 處理中 THEN 系統 SHALL 先回覆處理中狀態（reaction 或訊息），完成後更新。

### Requirement 11：排程任務

**User Story:** 身為行銷主管，我想要設定每日報告與週期性掃描，結果送到指定 channel。

ADR: ADR-0016

#### Acceptance Criteria

1. 系統 SHALL 提供 job 模板：`daily_report`、`negative_kw_sweep`、`budget_rebalance`、`tracking_audit`、`anomaly_watch`、`custom_prompt`。
2. 每個排程 SHALL 包含 cron、時區、帳戶清單、目標 ConversationRef、選填 `extra_instructions`。
3. `custom_prompt` 排程 SHALL 只能產生 Report 或 ChangeSet proposal，不得繞過 Executor。
4. 每次排程執行 SHALL 記錄 job run（開始/結束、狀態、產出、token 成本）。
5. Web SHALL 支援建立、編輯、停用、手動觸發排程。

### Requirement 12：熔斷與自動降價（Monitor）

**User Story:** 身為 admin，我想要花費失控或成效暴跌時系統立刻止血，事後告訴我原因。

ADR: ADR-0017

#### Acceptance Criteria

1. 系統 SHALL 每 15 分鐘執行不含 LLM 的 Monitor，評估 admin 設定的 monitor 規則。
2. Monitor 規則 SHALL 至少支援：花費 pacing 超過 X%、花費達上限的 Y%、N 小時 CPA 超過 target 的 K 倍且轉換數 ≥ M。
3. WHEN Monitor 規則觸發 THEN 系統 SHALL 產生 Tier 1 ChangeSet（暫停、降預算或降出價目標）交由 Executor，並遵守自動化模式。
4. 同一 entity 同一規則 SHALL 有冷卻期，避免重複觸發。
5. WHEN 熔斷 ChangeSet 執行或模擬完成 THEN 系統 SHALL 呼叫 Audit agent 產生根因分析（關聯 change_event），與 Undo/維持按鈕一起發送。

### Requirement 13：跨活動預算再分配與出價目標微調

**User Story:** 身為行銷人員，我想要依邊際效益把預算移到表現好的 campaign，且數字可解釋。

ADR: ADR-0018

#### Acceptance Criteria

1. 預算分配數字 SHALL 由決定性 optimizer 計算，輸入為各 campaign 邊際 CPA/ROAS 估計（budget simulator、近 14 天資料、lost IS budget）。
2. Optimizer SHALL 遵守：總預算守恆、單 campaign 單次變動 ≤ 設定比例、排除 learning 中或資料不足的 campaign。
3. Bidding agent SHALL 只能審視、排除 campaign、撰寫解釋，SHALL NOT 自行產生分配數字。
4. 預算再分配 ChangeSet SHALL 至少為 Tier 2。
5. tCPA/tROAS 微調 SHALL 每次不超過 ±15%（可設定）、受 `BidTargetRange` 規則限制，且 SHALL 跳過 learning 中的 campaign。

### Requirement 14：搜尋字詞分類與否定關鍵字

**User Story:** 身為行銷人員，我想要系統定期找出不相關的搜尋字詞並自動排除，同時不誤殺有價值的流量。

ADR: ADR-0019

#### Acceptance Criteria

1. 每個帳戶 SHALL 有 Business Profile：offerings、target_intents、excluded_intents、brand_terms、competitor_policy、examples。
2. `negative_kw_sweep` SHALL 以小模型批次（預設 100 筆）分類 search terms，輸出 intent、relevance、confidence、reason（structured output）。
3. 分類結果 SHALL 以 `(term, profile_version)` 快取，Profile 未變更時不重分類。
4. IF confidence ≥ 0.9 AND 近 90 天轉換 = 0 AND 不含 brand term AND cost > 0 THEN 系統 SHALL 產生 Tier 1 ChangeSet，以 EXACT match 加入專用 shared negative list。
5. 其他判定為不相關的字詞 SHALL 彙整為 Tier 2 批次 ChangeSet，approver 可逐項勾選。
6. WHEN approver 剔除某項 THEN 系統 SHALL 將其寫入 Business Profile examples 作為修正樣本。
7. 系統 SHALL 支援關鍵字擴展：從 search terms 與 Keyword Planner 產生候選，一律 Tier 2。

### Requirement 15：Campaign 內容產生

**User Story:** 身為行銷人員，我想要在 Web 提交 brief，由背景 agent 產生 Search campaign 草稿，我修改後送審上線。

ADR: ADR-0020

#### Acceptance Criteria

1. WHEN 使用者在 Web 提交 campaign brief THEN 系統 SHALL 建立 task（`queued`）並由 worker 背景執行 Campaign agent。
2. Campaign agent SHALL 產出：campaign 結構、ad groups、關鍵字與 match type、RSA（≤ 15 headlines、≤ 4 descriptions）、否定關鍵字、預算與出價建議。
3. 產出 SHALL 通過 lint：headline ≤ 30 字元、description ≤ 90 字元（依 Google 計算規則）、重複檢查、政策敏感字。
4. 產出 SHALL 存為可編輯 Draft，使用者可要求重生特定區段。
5. WHEN Draft 送出 THEN 系統 SHALL 建立 ChangeSet（至少 Tier 2）並以 `PAUSED` 狀態建立 campaign。
6. 啟用 campaign SHALL 為另一個 ChangeSet。
7. 系統 SHALL 同步 Google 政策審核狀態回 Draft 頁面。
8. Task 狀態 SHALL 包含 `queued`、`running`、`draft`、`submitted`、`failed`。

### Requirement 16：成效審計與歸因

**User Story:** 身為行銷主管，我想要每天知道轉換追蹤是否健康，以及指標劇烈波動是否和某次變更有關。

ADR: ADR-0021

#### Acceptance Criteria

1. `tracking_audit` SHALL 每日檢查每個 conversion action 的狀態、最後轉換時間與 Enhanced Conversions 診斷。
2. IF 某個 primary conversion action 超過 24h 無轉換且歷史日均 > 門檻 THEN 系統 SHALL 發出追蹤疑似失效警示。
3. 系統 SHALL 透過 GA4 Data API 取得 `google / cpc` 轉換並與 Ads 轉換比對；WHEN 落差相對 14 日基準偏移超過門檻 THEN SHALL 發出警示。
4. `anomaly_watch` SHALL 以統計方法偵測 clicks、CTR、CPC、轉換率、地區、placement 異常（例如 clicks 上升但 GA4 sessions 不變）。
5. WHEN 偵測到異常 THEN Audit agent SHALL 關聯異常時間點前後的 change_event 與 ChangeSet，產生可能原因排序。

### Requirement 17：受眾分析

**User Story:** 身為行銷人員，我想要知道哪些受眾表現好壞，並得到調整建議。

ADR: ADR-0022

#### Acceptance Criteria

1. 系統 SHALL 同步 user lists 與受眾區隔（observation / targeting）成效。
2. Agent SHALL 能提出出價加成調整或受眾排除的 ChangeSet（Tier 2）。
3. v1 SHALL NOT 上傳 Customer Match 或任何 PII。

### Requirement 18：Web console

**User Story:** 身為團隊成員，我想要在 Web 上看數據、審核變更、管理設定與 campaign 草稿。

ADR: ADR-0003, ADR-0010

#### Acceptance Criteria

1. 總覽頁 SHALL 顯示 MTD 花費、當月 pacing 預測、預算上限、各 campaign 的 spend / impr / clicks / CTR / CPC / conv / CPA / ROAS / IS / lost IS(budget, rank)。
2. 趨勢圖 SHALL 在時間軸上標示 change_event 與 ChangeSet。
3. 審核佇列 SHALL 列出所有 ChangeSet 並可依狀態、tier、帳戶篩選，顯示 diff、validator 結果、approver、OpenAI trace 連結；具權限者可 approve / reject / undo。
4. 設定頁 SHALL 管理：validator 規則、monitor 規則、tier 門檻、自動化模式、排程、RBAC、Business Profile、LLM 預算。
5. Campaign 工作區 SHALL 支援提交 brief、檢視 task 進度、編輯 Draft、送出。
6. 搜尋字詞頁 SHALL 顯示 search terms、意圖分類、否定關鍵字歷史。
7. 追蹤健康頁 SHALL 顯示各 conversion action 狀態與 GA4 落差。
8. Web 上的 approve / undo SHALL 與 Slack 共用相同權限檢查與 Executor 流程。

### Requirement 19：LLM 模型與成本控制

**User Story:** 身為 admin，我想要控制 LLM 成本並能替換模型。

ADR: ADR-0023, ADR-0024

#### Acceptance Criteria

1. 每個 agent 使用的模型 SHALL 由設定檔決定，可不改程式替換。
2. 系統 SHALL 記錄每次 run 的 token 用量與估算成本，關聯 task / job run / session。
3. WHEN 當日 LLM 成本超過 `daily_llm_budget_usd` THEN 系統 SHALL 暫停非關鍵排程（報告、擴展類）並通知 admin；Monitor 與 Executor 不受影響。
4. 系統 SHALL 使用 SDK 預設 tracing 匯出至 OpenAI，並在 ChangeSet / task / job run 記錄 `trace_id`。

### Requirement 20：部署與營運（v1）

**User Story:** 身為工程師，我想要先在一台 EC2 上用 docker compose 跑起全部系統，之後再搬遷。

ADR: ADR-0002, ADR-0025, ADR-0026

#### Acceptance Criteria

1. 系統 SHALL 提供 `docker-compose.yml`（本機開發）與 `docker-compose.prod.yml`（EC2），包含 `web`、`worker`、`postgres`、`caddy`。
2. Caddy SHALL 以設定的網域自動取得 TLS 憑證並反向代理至 web。
3. Postgres 資料 SHALL 存於掛載的獨立 EBS 路徑。
4. 系統 SHALL 提供每日 `pg_dump` 至 S3 的備份腳本（保留 30 天）。
5. 系統 SHALL 提供 `scripts/deploy.sh`：`git pull` → build → migrate → `up -d`。
6. 所有 secrets SHALL 由 `.env` 注入，`.env` 不得進版控，repo 提供 `.env.example`。
7. 應用程式 SHALL 不依賴 EC2 特有的本機狀態（除 Postgres volume），以便日後搬遷至 ECS/RDS。
8. 系統 SHALL 提供 `/healthz` 端點（web、worker 各自）供監控使用。
9. 開發環境 SHALL 能以唯讀方式讀取正式帳戶；寫入 SHALL 只指向測試帳戶（以設定強制）。
