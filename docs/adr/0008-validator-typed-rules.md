# ADR-0008：Validator 採固定規則型別 + 參數

- Status: Accepted
- Date: 2026-10-06
- Requirements: 5.1–5.6

## Decision
規則型別在程式定義，admin 只設定參數、scope、severity：

```ts
type RuleSpec =
  | { type: 'DailyBudgetCap'; max: number }
  | { type: 'MonthlySpendCap'; max: number }
  | { type: 'MaxChangePct'; pct: number; windowHours: number }
  | { type: 'BidTargetRange'; metric: 'tcpa' | 'troas'; min: number; max: number }
  | { type: 'MaxMutationsPerDay'; n: number };
```

- scope：org → account → campaign，窄覆寫寬。
- severity：`HARD_BLOCK` / `WARN`。
- `validate(changeSet, ctx, rules) → Violation[]` 為純函式。

## Alternatives
- JSON Logic / CEL 表達式：彈性高，但寫錯可能悄悄放行。可在 v2 加入 `CustomExpression` 型別。

## Consequences
- 新規則型別需要改 code 與 UI 表單；換來型別安全與可測試性。
