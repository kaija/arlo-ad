# ADR-0012：Undo — 24h 時間窗一鍵還原 + 漂移檢查

- Status: Accepted
- Date: 2026-10-06
- Requirements: 8.1–8.5

## Decision
- `EXECUTED` 後 24h 內，`operator` 以上可 Undo。
- Undo **不經 validator、不需 approval**，但保留漂移檢查：現況 = 原 `after` 才寫回 `before`；否則拒絕並顯示目前值與（從 change_event 推得的）修改者。
- Undo 產生 `revert_of` 指向原 ChangeSet 的新紀錄；原 ChangeSet 標 `REVERTED`。

## Alternatives
- Undo 走完整 Executor 流程（反向 ChangeSet 重算 tier）：較一致，但慢。
- 強制寫回：會蓋掉人工變更。

## Consequences
- Undo「重新啟用」等擴張性動作會繞過 validator；以 24h 窗、角色限制、稽核紀錄緩解。
