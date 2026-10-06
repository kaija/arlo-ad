# ADR-0024：Tracing 使用 OpenAI 預設 + trace_id 連結

- Status: Accepted
- Date: 2026-10-06
- Requirements: 19.4, 3.7

## Context
openai-agents-js 內建 tracing（LLM generation、tool call、handoff、guardrail），預設以 BatchTraceProcessor 匯出至 OpenAI Traces；可用 `addTraceProcessor` / `setTraceProcessors` / `setTracingDisabled` 調整。

## Decision
- 使用預設匯出至 OpenAI Traces dashboard。
- 每個 run 以 `withTrace()` 包裝並帶 metadata（task_id、changeset_id、session_id）；`trace_id` 存入 ChangeSet / task / job_run，Web 顯示連結。
- 系統 log 以 JSON（pino）輸出至 stdout，由 docker logging 收集。

## Alternatives
- 自訂 processor 寫入 Postgres：可在 Web 內嵌推理過程，延後評估。
- Langfuse / LangSmith：多一個系統。

## Consequences
- 廣告數據會存在 OpenAI 平台（依 OpenAI 資料政策）。
- 日後可用 `addTraceProcessor` 加第二目的地，不需改 agent code。
