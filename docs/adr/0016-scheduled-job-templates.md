# ADR-0016：排程 = Job 模板 + 可選 prompt

- Status: Accepted
- Date: 2026-10-06
- Requirements: 11.1–11.5

## Decision
```ts
interface ScheduledJob {
  template: 'daily_report' | 'negative_kw_sweep' | 'budget_rebalance'
          | 'tracking_audit' | 'anomaly_watch' | 'custom_prompt';
  cron: string; tz: string;
  accountIds: string[];
  target: ConversationRef;
  extraInstructions?: string;
  enabled: boolean;
}
```
- 每個模板對應一個 handler（決定性前處理 + 專業 agent + 固定 output schema）。
- `custom_prompt` 只能輸出 Report 或 propose ChangeSet。
- 由 pg-boss `schedule()` 驅動，每次執行寫 `job_runs`。

## Consequences
- 輸出可預測、易審計；新模板需改 code。
