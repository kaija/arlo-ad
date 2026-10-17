# 歷史 metrics 回補（sync-backfill）

排程同步只拉當日（`sync.hourly`）與 D-3..D-1（`sync.daily`），所以帳戶上線前的 `metrics_daily` 是空的：Overview 的當月花費、預估花費與 30 天趨勢會從上線日開始。`sync-backfill` 一次補齊 D-N..D-1 的每日 metrics（account / campaign / ad group / keyword）與 search terms。

- **只讀** Google Ads（adapter 以空的寫入白名單建立），寫入只有本機 Postgres。
- 每 7 天一個請求（`--chunk-days` 可調），從最近的區間往前拉：中途失敗時當月資料已經先補好。
- 冪等：重跑會以 Google Ads 的數字覆寫同一天的資料，不會重複。和正在跑的 worker 同時執行也沒問題（同樣是 upsert）。
- 當日不在範圍內，留給 `sync.hourly`。
- 只補已經同步成 entity 的對象：帳戶與 entity 來自 worker 的 `sync.snapshots`（每 15 分鐘），新帳戶要先等它跑過一次。上線前就已移除的 campaign / ad group / keyword 不會被同步成 entity，它們的 metrics 會被略過（log 的 `skipped`）；account 層級的總額不受影響。
- 不會自動執行，新帳戶上線時手動跑一次。

## 在 EC2 上執行

在 repo 目錄（`docker-compose.prod.yml` 所在處）執行；使用與 worker 相同的 `.env` 與 image：

```bash
# 所有 active 帳戶，回補 60 天
docker compose -f docker-compose.prod.yml run --rm worker sync-backfill --days 60

# 只補指定帳戶（可重複 --account；customer ID 可帶或不帶 -）
docker compose -f docker-compose.prod.yml run --rm worker sync-backfill --days 60 --account 123-456-7890

# 不拉 search terms
docker compose -f docker-compose.prod.yml run --rm worker sync-backfill --days 60 --no-search-terms
```

本機（不經 Docker）：

```bash
DATABASE_URL=... GOOGLE_ADS_CLIENT_ID=... pnpm --filter @arlo/worker sync:backfill --days 60
```

| 參數 | 說明 |
|---|---|
| `--days <n>` | 必填。回補 D-n..D-1（帳戶時區） |
| `--account <externalId>` | 只補這些帳戶；預設為 DB 中所有 active 的 Google Ads 帳戶 |
| `--chunk-days <n>` | 每個請求的天數，預設 7。keyword 非常多的帳戶可調小 |
| `--no-search-terms` | 只補 metrics |

## 結果與失敗處理

每個區間記一行 `backfill chunk done`，每個帳戶結束記 `backfill done`（`metrics`、`searchTerms`、`skipped`），最後 `backfill finished`。某個帳戶失敗時會記 `backfill failed` 並繼續下一個帳戶，最後以 exit code 1 結束；只要對失敗的帳戶加 `--account` 重跑即可。

API 配額：每個帳戶每 7 天約 5 個 search 請求（4 個 metrics 層級 + search terms），60 天約 45 個。Explorer 等級每日 2,880 次，19 個帳戶 × 60 天約 850 次，再加上平常的同步，請避免在同一天重複全量回補。
