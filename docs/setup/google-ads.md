# Google Ads API 憑證設定

Worker（`apps/worker`）透過 Google Ads API 同步帳戶資料並執行變更，需要以下環境變數（見 `.env.example`）：

| 變數 | 內容 | 從哪裡取得 |
|---|---|---|
| `GOOGLE_ADS_CLIENT_ID` | OAuth client ID | Google Cloud Console → [步驟 2](#2-建立-oauth-client) |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth client secret | 同上 |
| `GOOGLE_ADS_REFRESH_TOKEN` | 有 `adwords` scope 的 refresh token | OAuth Playground → [步驟 3](#3-取得-refresh-token) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | 管理員帳戶（MCC）的 customer ID | Google Ads UI → [步驟 4](#4-設定-customer-id) |
| `ADS_WRITE_ALLOWED_CUSTOMER_IDS` | 允許寫入的帳戶（逗號分隔） | 自己決定 → [步驟 4](#4-設定-customer-id) |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | 已停用，見下方說明 | — |

只有 worker 會讀這些變數；web 不需要。

> **Developer token 已於 2026-09-09 停用。** Google 改以 **OAuth client 所在的 Google Cloud project** 決定 API 存取等級，不再發新的 developer token，也不要再從管理員帳戶的 API Center 申請。API 仍接受 `developer-token` header，但會忽略其值，未來的 API 主要版本會拒絕它。
> 目前 `@arlo/config` 的 `EnvSchema` 仍把 `GOOGLE_ADS_DEVELOPER_TOKEN` 設為必填：有舊 token 就沿用，沒有就填任意非空字串（例如 `unused`）。

---

## 1. 準備 Google Cloud project 與存取等級

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 建立（或選用）一個 project，之後的 OAuth client 都建在這個 project 下。存取等級跟著這個 project 走：用別的 project 建 OAuth client 的話，等級會降回 Test，看不到正式帳戶。
2. 在 **APIs & Services → Library** 啟用 **Google Ads API**。
3. 開啟 **Google Ads API Overview** 頁面，確認目前的存取等級，需要時申請升級：

   | 等級 | 可存取的帳戶 | 每日操作上限 | 取得方式 |
   |---|---|---|---|
   | Test | 只有測試帳戶 | 15,000 | 啟用 API 後自動取得 |
   | Explorer | 測試與正式帳戶 | 正式 2,880 / 測試 15,000 | 在 Overview 頁「Upgrade access level」申請 |
   | Basic | 測試與正式帳戶 | 15,000 | 先完成 brand verification，再從 Explorer 申請 |
   | Standard | 測試與正式帳戶 | 無上限 | 從 Basic 申請，需人工審核 |

   - 申請者需要該 project 的 Owner、Editor、Quota Administrator 或 Service Usage Admin 角色。
   - 開發階段用 Test 即可（配合[測試帳戶](#開發用測試帳戶)）。正式環境至少要 Explorer；每天同步多個帳戶時，建議用 Basic。
   - 已知問題：project 若在免費試用期，或 billing 被停用，可能申請 Explorer/Basic 被拒；2026-09-09 之後才升級的 project，可能在正式帳戶上遇到 `AUTHORIZATION_ERROR`（Google 修正中）。
4. 確認團隊中負責的人在 project 中有 Owner 或 Editor 角色：Google 的強制服務公告會寄給他們。

## 2. 建立 OAuth client

1. **APIs & Services → OAuth consent screen**（Google Auth Platform）：
   - **User type 選 Internal**（只有 Google Workspace 組織可選）。若只能選 **External**，要把 Publishing status 設為 **In production**：狀態是 Testing 時，refresh token 7 天後就會失效，worker 會開始驗證失敗。
   - Scopes 加上 `https://www.googleapis.com/auth/adwords`。
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**：
   - Application type：**Web application**
   - Authorized redirect URIs：加入 `https://developers.google.com/oauthplayground`（步驟 3 會用到）
3. 把 Client ID 和 Client secret 填入 `GOOGLE_ADS_CLIENT_ID`、`GOOGLE_ADS_CLIENT_SECRET`。

這個 client 和 Web 登入用的 `GOOGLE_OAUTH_CLIENT_ID`（ADR-0010）是不同用途，建議分開建立，避免改了其中一個的 redirect URI 或 scope 影響另一個。

## 3. 取得 refresh token

用一個**有權限存取管理員帳戶**的 Google 帳號授權。建議用專用的服務帳號（例如 `ads-bot@<domain>`），不要用個人帳號，避免人員異動時 token 失效。

1. 開啟 [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)。
2. 右上角齒輪 → 勾選 **Use your own OAuth credentials**，填入步驟 2 的 Client ID / Client secret。
3. 左側 **Step 1** 輸入 scope `https://www.googleapis.com/auth/adwords` → **Authorize APIs**，用上面那個 Google 帳號登入並同意。
4. **Step 2** → **Exchange authorization code for tokens**，複製 **Refresh token** 填入 `GOOGLE_ADS_REFRESH_TOKEN`。
5. 回到齒輪，取消勾選自訂憑證，避免 Playground 保留你的 secret。

授權用的帳號被移除權限、改密碼（部分情況），或在 [Google 帳戶權限頁](https://myaccount.google.com/permissions) 撤銷存取時，refresh token 就會失效，需要重做這個步驟。

## 4. 設定 customer ID

Customer ID 是 Google Ads UI 右上角的 10 位數字（`123-456-7890`）。有沒有破折號都可以，程式會自動去除。

- **`GOOGLE_ADS_LOGIN_CUSTOMER_ID`**：管理員帳戶（MCC）的 ID。Sync 會從這個帳戶列出底下所有 `ENABLED` 的非管理員子帳戶（`customer_client`），並以它作為 `login-customer-id` 存取各子帳戶。要納管的廣告帳戶都必須連結在這個 MCC 底下，且步驟 3 授權的 Google 帳號要能存取這個 MCC。
- **`ADS_WRITE_ALLOWED_CUSTOMER_IDS`**：Executor 可以寫入的帳戶清單（ADR-0026），以逗號分隔。**留空代表完全不允許寫入**（只同步、只讀）。開發環境只放測試帳戶；`pnpm test:contract` 只會寫入清單中的第一個帳戶。

### 開發用測試帳戶

Test 等級只能存取測試帳戶。測試帳戶不會投放廣告，也不會花錢，適合本機開發與 contract test：

1. 用一個**沒有連結任何正式 MCC** 的 Google 帳號，在 [Google Ads 管理員帳戶頁](https://ads.google.com/home/tools/manager-accounts/) 建立一個 **test manager account**（建立時選測試帳戶）。
2. 在這個測試 MCC 底下建立測試子帳戶，並建一個有**獨立預算**的 campaign（contract test 需要）。
3. 用這個 Google 帳號做步驟 3 取得 refresh token；`GOOGLE_ADS_LOGIN_CUSTOMER_ID` 填測試 MCC，`ADS_WRITE_ALLOWED_CUSTOMER_IDS` 填測試子帳戶。

## 5. 填入設定並驗證

1. 本機填在 repo 根目錄的 `.env`；正式環境填在 EC2 上 `docker-compose.prod.yml` 使用的 `.env`。不要提交到 git。
2. 先確認 client 和 refresh token 能換到 access token（不需要 API 版本）。先把 `.env` 載入目前的 shell：

   ```bash
   set -a; source .env; set +a
   ```

   ```bash
   curl -s https://oauth2.googleapis.com/token -d grant_type=refresh_token -d client_id="$GOOGLE_ADS_CLIENT_ID" -d client_secret="$GOOGLE_ADS_CLIENT_SECRET" -d refresh_token="$GOOGLE_ADS_REFRESH_TOKEN" | jq 'del(.access_token)'
   ```

   回應有 `expires_in` 和 `scope`（包含 `adwords`）代表成功；`invalid_grant` 代表 refresh token 失效或被撤銷（重做步驟 3），`invalid_client` 代表 client ID / secret 不對。
3. 用測試帳戶跑 contract test（會讀寫 `ADS_WRITE_ALLOWED_CUSTOMER_IDS` 第一個帳戶，所有變更都會還原）：

   ```bash
   pnpm test:contract
   ```

4. 重啟 worker 讓設定生效：本機 `docker compose up -d worker`；EC2 上執行 `scripts/deploy.sh --no-pull`。之後在 worker log 確認 sync job 成功，並檢查 `sync_state` 表。

## 常見錯誤

| 錯誤 | 原因 | 處理 |
|---|---|---|
| `invalid_grant` | Refresh token 失效（7 天過期、撤銷、帳號權限被移除） | 確認 consent screen 為 Internal 或 In production，重做步驟 3 |
| `USER_PERMISSION_DENIED` | 授權的 Google 帳號無法存取 `GOOGLE_ADS_LOGIN_CUSTOMER_ID`，或子帳戶不在該 MCC 底下 | 在 Google Ads 把帳號加入 MCC，或修正 login customer ID |
| 只能存取測試帳戶（例如 `DEVELOPER_TOKEN_NOT_APPROVED`） | Cloud project 的存取等級仍是 Test | 在 Google Ads API Overview 頁申請 Explorer 以上；確認 OAuth client 建在同一個 project |
| `AUTHORIZATION_ERROR`（2026-09-09 後升級的 project） | Google 端的已知問題 | 等 Google 修正，或聯絡 Google Ads API support |
| `CUSTOMER_NOT_ENABLED` | 帳戶尚未啟用或已取消 | 在 Google Ads 完成帳戶設定；sync 只會列出 `ENABLED` 的帳戶 |
| Executor 回 `WRITE_NOT_ALLOWED` | 帳戶不在 `ADS_WRITE_ALLOWED_CUSTOMER_IDS` | 確認後加入清單並重啟 worker |

## 參考

- [Access levels and permissible use](https://developers.google.com/google-ads/api/docs/api-policy/access-levels)
- [Developer token（停用說明與遷移）](https://developers.google.com/google-ads/api/docs/api-policy/developer-token)
- [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
- ADR-0004（PlatformAdapter）、ADR-0026（寫入白名單）
