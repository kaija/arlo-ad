# ADR-0001：單一組織內部工具

- Status: Accepted
- Date: 2026-10-06
- Requirements: 1.7

## Context
系統可以定位為內部工具、代理商多客戶工具或多租戶 SaaS，三者在資料隔離、OAuth、Slack App 發佈上的複雜度差距很大。

## Decision
v1 為**內部單一團隊**使用：一個 Slack workspace、一個 Google Ads MCC（單一 OAuth refresh token）管理其下多個帳戶。所有資料表保留 `org_id`，v1 只有一筆 org。

## Alternatives
- 代理商多客戶：需要 client × user 的 RBAC 與 per-client 路由，目前沒有需求。
- 多租戶 SaaS：需要 Slack OAuth distribution、per-tenant token 加密、Google Ads Standard access 審核，成本過高。

## Consequences
- 最快上線；所有 token 為單一組設定。
- 未來轉多租戶時，`org_id` 已存在，主要工作在 token 儲存與 Slack install flow。
