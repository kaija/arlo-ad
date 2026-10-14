import { authorize, DEFAULT_TIER_THRESHOLDS } from '@arlo/core';
import { listTierThresholds, resolveAccounts } from '@arlo/db';
import { getTranslations } from 'next-intl/server';
import { ThresholdForm } from '../../../../components/threshold-form';
import { Alert, Button, PageHeader } from '../../../../components/ui';
import { thresholdsToForm } from '../../../../lib/rules';
import { getDb } from '../../../../lib/server';
import { requireUser } from '../../../../lib/session';
import { clearThresholdsAction, saveThresholdsAction } from './actions';

export const dynamic = 'force-dynamic';

// Tier thresholds (ADR-0007, Requirement 18.4): an org default, overridable per account.
export default async function ThresholdsPage() {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const db = getDb();
  const [rows, accounts] = await Promise.all([listTierThresholds(db), resolveAccounts(db, { allowed: null })]);
  const org = rows.find((r) => r.accountId === null);
  const t = await getTranslations('thresholds');
  const ts = await getTranslations('settings');
  const orgValues = org ? { tier3Pct: org.tier3Pct, tier3AmountMicros: org.tier3AmountMicros, tier1MaxReducePct: org.tier1MaxReducePct } : DEFAULT_TIER_THRESHOLDS;

  return (
    <>
      <PageHeader
        back={{ href: '/settings', label: ts('title') }}
        title={t('title')}
        subtitle={t('subtitle')}
      />
      {isAdmin ? null : <Alert title={ts('readOnlyTitle')}>{ts('readOnlyBody')}</Alert>}
      <div className="flex flex-col gap-4">
        <ThresholdForm action={saveThresholdsAction.bind(null, null)} initial={thresholdsToForm(orgValues)} title={t('orgDefault')} meta={org ? t('orgApplied') : t('builtIn')} disabled={!isAdmin} />
        {accounts.map((a) => {
          const own = rows.find((r) => r.accountId === a.id);
          return (
            <ThresholdForm
              key={a.id}
              action={saveThresholdsAction.bind(null, a.id)}
              initial={thresholdsToForm(own ? { tier3Pct: own.tier3Pct, tier3AmountMicros: own.tier3AmountMicros, tier1MaxReducePct: own.tier1MaxReducePct } : orgValues)}
              title={a.name}
              meta={`${a.externalId} · ${a.currency}${own ? '' : ` · ${t('inheritsOrg')}`}`}
              currency={a.currency}
              disabled={!isAdmin}
              extra={
                own && isAdmin ? (
                  <form action={clearThresholdsAction.bind(null, a.id)}>
                    <Button size="sm">{t('revert')}</Button>
                  </form>
                ) : null
              }
            />
          );
        })}
      </div>
    </>
  );
}
