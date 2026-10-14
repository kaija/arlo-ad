import { authorize, AUTOMATION_FEATURES, AUTOMATION_MODES, formatPct, type AutomationFeature } from '@arlo/core';
import { getTranslations } from 'next-intl/server';
import { Alert, Badge, DataTable, Icon, PageHeader, Progress, type IconName } from '../../../components/ui';
import { loadAutomation } from '../../../lib/automation';
import { getDb } from '../../../lib/server';
import { readableAccounts, requireUser } from '../../../lib/session';
import { setModeAction } from './actions';

export const dynamic = 'force-dynamic';

const MODE_TONE = { off: 'neutral', shadow: 'info', live: 'ok' } as const;
const FEATURE_ICON: Record<AutomationFeature, IconName> = { negative_kw_auto: 'filter', circuit_breaker: 'zap', bid_auto_reduce: 'waveform', budget_rebalance: 'regenerate' };


// Automation modes and shadow accuracy (ADR-0013, Requirements 9.1, 9.5).
export default async function AutomationPage() {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const { rows, totals } = await loadAutomation(getDb(), readableAccounts(user));
  const t = await getTranslations('automation');
  const accuracyText = (c: { judged: number; correct: number; accuracy: number | null; simulated: number }) =>
    c.accuracy === null ? t('noFeedback', { simulated: c.simulated }) : t('feedback', { correct: c.correct, judged: c.judged, simulated: c.simulated });

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {isAdmin ? null : <Alert title={t('readOnlyTitle')}>{t('readOnlyBody')}</Alert>}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
        {AUTOMATION_FEATURES.map((f) => {
          const total = totals[f];
          return (
            <div key={f} className="card card-sm flex flex-col gap-2.5">
              <span className="icon-tile h-9 w-9">
                <Icon name={FEATURE_ICON[f]} size={18} />
              </span>
              <span className="text-ui font-semibold">{t(`feature.${f}`)}</span>
              {total.accuracy === null ? (
                <span className="stat-value leading-[1.1] text-faint">—</span>
              ) : (
                <>
                  <span className="stat-value leading-[1.1]">{formatPct(total.accuracy, 0)}</span>
                  <Progress value={total.accuracy} tone={total.accuracy >= 0.9 ? 'success' : undefined} />
                </>
              )}
              <span className="text-meta text-faint">{accuracyText(total)}</span>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="section-title">{t('matrix')}</h2>
          <span className="text-meta text-faint">{t('matrixHint')}</span>
        </div>
        {rows.length === 0 ? (
          <div className="card card-sm p-10 text-center text-sm text-muted">{t('noAccounts')}</div>
        ) : (
          <DataTable minWidth={1000}>
            <thead>
              <tr>
                <th>{t('account')}</th>
                {AUTOMATION_FEATURES.map((f) => (
                  <th key={f}>{t(`feature.${f}`)}</th>
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
                            <form action={setModeAction.bind(null, account.id, f)} className="tabs tabs-pill" role="tablist" aria-label={`${account.name} ${t(`feature.${f}`)}`}>
                              {AUTOMATION_MODES.map((m) => (
                                <button key={m} type="submit" name="mode" value={m} role="tab" aria-selected={cell.mode === m} className="tab">
                                  {t(`mode.${m}`)}
                                </button>
                              ))}
                            </form>
                          ) : (
                            <Badge tone={MODE_TONE[cell.mode]} dot>
                              {t(`mode.${cell.mode}`)}
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
