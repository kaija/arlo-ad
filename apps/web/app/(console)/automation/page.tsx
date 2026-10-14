import { authorize, AUTOMATION_FEATURES, AUTOMATION_MODES, formatPct, type AutomationFeature } from '@arlo/core';
import { Alert, Badge, DataTable, Icon, PageHeader, Progress, type IconName } from '../../../components/ui';
import { FEATURE_LABEL, loadAutomation } from '../../../lib/automation';
import { getDb } from '../../../lib/server';
import { readableAccounts, requireUser } from '../../../lib/session';
import { setModeAction } from './actions';

export const dynamic = 'force-dynamic';

const MODE_TONE = { off: 'neutral', shadow: 'info', live: 'ok' } as const;
const MODE_SHORT = { off: '關閉', shadow: 'Shadow', live: 'Live' } as const;
const FEATURE_ICON: Record<AutomationFeature, IconName> = { negative_kw_auto: 'filter', circuit_breaker: 'zap', bid_auto_reduce: 'waveform', budget_rebalance: 'regenerate' };

function accuracyText(c: { judged: number; correct: number; accuracy: number | null; simulated: number }) {
  return c.accuracy === null ? `${c.simulated} 次模擬 · 尚無回饋` : `${c.correct} / ${c.judged} 筆回饋正確 · ${c.simulated} 次模擬`;
}

// Automation modes and shadow accuracy (ADR-0013, Requirements 9.1, 9.5).
export default async function AutomationPage() {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const { rows, totals } = await loadAutomation(getDb(), readableAccounts(user));

  return (
    <>
      <PageHeader title="自動化" subtitle="Shadow 會完整驗證與分級，但不寫入 Google Ads，並在 Slack 收集 👍 / 👎 回饋。準確率足夠後再切到 Live 自動執行。新帳戶預設為 Shadow。" />
      {isAdmin ? null : <Alert title="唯讀">只有 Admin 可以切換自動化模式。</Alert>}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
        {AUTOMATION_FEATURES.map((f) => {
          const t = totals[f];
          return (
            <div key={f} className="card card-sm flex flex-col gap-2.5">
              <span className="icon-tile h-9 w-9">
                <Icon name={FEATURE_ICON[f]} size={18} />
              </span>
              <span className="text-ui font-semibold">{FEATURE_LABEL[f]}</span>
              {t.accuracy === null ? (
                <span className="stat-value leading-[1.1] text-faint">—</span>
              ) : (
                <>
                  <span className="stat-value leading-[1.1]">{formatPct(t.accuracy, 0)}</span>
                  <Progress value={t.accuracy} tone={t.accuracy >= 0.9 ? 'success' : undefined} />
                </>
              )}
              <span className="text-meta text-faint">{accuracyText(t)}</span>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="section-title">帳戶 × 功能</h2>
          <span className="text-meta text-faint">每格顯示目前模式與該格的 Shadow 準確率</span>
        </div>
        {rows.length === 0 ? (
          <div className="card card-sm p-10 text-center text-sm text-muted">沒有可檢視的帳戶。</div>
        ) : (
          <DataTable minWidth={1000}>
            <thead>
              <tr>
                <th>帳戶</th>
                {AUTOMATION_FEATURES.map((f) => (
                  <th key={f}>{FEATURE_LABEL[f]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ account, features }) => (
                <tr key={account.id}>
                  <td className="font-medium whitespace-nowrap">
                    {account.name}
                    <div className="font-mono text-xs font-normal text-faint">{account.externalId}</div>
                  </td>
                  {AUTOMATION_FEATURES.map((f) => {
                    const cell = features[f];
                    return (
                      <td key={f}>
                        <div className="flex flex-col items-start gap-1.5">
                          {isAdmin ? (
                            <form action={setModeAction.bind(null, account.id, f)} className="tabs tabs-pill" role="tablist" aria-label={`${account.name} ${FEATURE_LABEL[f]}`}>
                              {AUTOMATION_MODES.map((m) => (
                                <button key={m} type="submit" name="mode" value={m} role="tab" aria-selected={cell.mode === m} className="tab">
                                  {MODE_SHORT[m]}
                                </button>
                              ))}
                            </form>
                          ) : (
                            <Badge tone={MODE_TONE[cell.mode]} dot>
                              {MODE_SHORT[cell.mode]}
                            </Badge>
                          )}
                          <span className="text-xs text-faint">{cell.accuracy === null ? accuracyText(cell) : `${formatPct(cell.accuracy, 0)} · ${accuracyText(cell)}`}</span>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
    </>
  );
}
