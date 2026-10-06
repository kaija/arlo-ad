# ADR-0010：Google Workspace SSO + Slack 身分對應 + RBAC

- Status: Accepted
- Date: 2026-10-06
- Requirements: 1.1–1.6, 18.8

## Decision
- Web 使用 Auth.js Google provider，限定 Workspace domain（`hd`）。
- 內部 `users` 表為身分主鍵，綁定 `google_email`、`slack_user_id`；首次登入以 `users.lookupByEmail` 自動綁定，失敗由 admin 手動綁定。
- 角色：`viewer` / `operator` / `approver` / `admin`；`role_bindings` 可限定 account scope 與 `max_tier`。
- 權限檢查集中於 `authorize(user, action, changeSet)`，Slack 與 Web 共用。
- Tier 3：`approver != requester`。

## Alternatives
- Sign in with Slack：身分天然一致，但使用者選擇與 Google 世界一致。
- 自建 auth provider：對內部工具過重。

## Consequences
- 需處理 email 不一致的手動綁定流程。
- Slack 互動者若未綁定，一律拒絕。
