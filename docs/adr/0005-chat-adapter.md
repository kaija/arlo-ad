# ADR-0005：語意層 ChatAdapter，v1 只做 Slack

- Status: Accepted
- Date: 2026-10-06
- Requirements: 7.6, 7.7

## Context
需求提到「Slack 或其他 chat service」。各平台互動能力（Block Kit、Adaptive Card）差異大。

## Decision
- 核心只輸出語意訊息：`ApprovalRequest`、`Report`、`Notice`、`ShadowResult`。
- 對話位置以 `ConversationRef { platform, channelId, threadId }` 表示。
- `ChatAdapter` 介面負責 `post / update / fetchContext / resolveUser`，v1 只實作 `SlackAdapter`（Block Kit）。
- Executor、Scheduler、Monitor 不得直接 import Slack SDK。

## Alternatives
- Slack only：最快但日後重寫。
- 第三方多平台 chat SDK：approval 互動支援度未驗證。

## Consequences
- 新 chat 平台只需新 adapter 與渲染器。
- 少數 Slack 特性（modal、App Home）需透過 adapter 擴充方法暴露。
