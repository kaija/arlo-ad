# ADR-0025：v1 部署 — 單台 EC2 + docker compose

- Status: Accepted（取代原先 ECS Fargate + RDS 的規劃，該方案保留為搬遷目標）
- Date: 2026-10-06
- Requirements: 20.1–20.8

## Context
想先用最少基礎設施把全部系統跑起來，日後再搬到 ECS/RDS 或其他平台。

## Decision
- 單台 EC2（建議 t3.large / 50GB gp3 root + 獨立 gp3 data volume），手動在 console 建立，綁 Elastic IP。
- `docker-compose.prod.yml`：`caddy`、`web`、`worker`、`postgres`。
- **Ingress**：子網域 A record → EIP；Caddy 自動 Let's Encrypt；Security group 開 80/443；**22 只開放 admin IP allowlist、金鑰登入**。
- **Postgres**：compose container，資料目錄掛在獨立 EBS（`/data/pg`）；每日 `pg_dump` → S3（30 天 lifecycle），另設 EBS snapshot。EC2 IAM role 只授予該 bucket 寫入。
- **部署**：SSH → `scripts/deploy.sh`（`git pull` → `docker compose build` → migrate → `up -d`）。
- **Secrets**：EC2 上 `.env`（`chmod 600`），repo 只提供 `.env.example`。

## Migration path
- DB：`pg_dump` → RDS restore，改 `DATABASE_URL`。
- Compute：同一 Dockerfile → ECR → ECS；DNS 指向 ALB。
- 應用程式不得依賴本機檔案系統（除 Postgres volume）。

## Consequences
- 單點故障；以備份與 runbook 緩解，RTO 以小時計。
- 無 CI/CD 自動部署；之後可補 GitHub Actions + ECR + SSM。
- 選擇 git pull 部署與「不開 SSH」衝突，改為 IP allowlist SSH。
