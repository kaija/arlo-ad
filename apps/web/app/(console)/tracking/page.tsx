import { authorize, formatNumber } from '@arlo/core';
import { resolveAccounts } from '@arlo/db';
import { getTranslations } from 'next-intl/server';
import { Alert, Badge, Button, Card, DataTable, Input, PageHeader } from '../../../components/ui';
import { getDb } from '../../../lib/server';
import { readableAccounts, requireUser } from '../../../lib/session';
import { formatAt } from '../../../lib/time';
import { loadTracking } from '../../../lib/tracking';
import { setGa4PropertyAction } from './actions';

export const dynamic = 'force-dynamic';

const TONE = { ok: 'ok', warn: 'warn', critical: 'bad' } as const;
const METRICS = ['clicks', 'ctr', 'cpc', 'cvr', 'cost', 'conversions', 'clicks_vs_sessions'] as const;
const isMetric = (m: string): m is (typeof METRICS)[number] => (METRICS as readonly string[]).includes(m);

// Conversion tracking health, GA4 gap and anomalies (Requirement 18.7, ADR-0021).
export default async function TrackingPage({ searchParams }: { searchParams: Promise<{ account?: string; error?: string }> }) {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const db = getDb();
  const params = await searchParams;
  const accounts = await resolveAccounts(db, { allowed: readableAccounts(user) });
  const account = accounts.find((a) => a.id === params.account) ?? accounts[0];
  const t = await getTranslations('tracking');
  if (!account) {
    return (
      <>
        <PageHeader title={t('title')} subtitle={t('subtitleShort')} />
        <div className="card flex flex-col items-center gap-2.5 px-7 py-16 text-center">
          <h2 className="section-title">{t('noAccountTitle')}</h2>
          <p className="text-sm text-muted">{t('noAccountBody')}</p>
        </div>
      </>
    );
  }
  const { health, gap, series, anomalies, categories, primary } = await loadTracking(db, account, new Date());
  const ratio = (r: number | null) => (r === null ? '—' : formatNumber(r, 2));
  const sinceLast = (hours: number | null) =>
    hours === null
      ? t('sinceLast.over30d')
      : hours < 1
        ? t('sinceLast.minutes', { n: Math.round(hours * 60) })
        : hours < 48
          ? t('sinceLast.hours', { n: Math.round(hours) })
          : t('sinceLast.days', { n: Math.floor(hours / 24) });

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle', { timezone: account.timezone })}
        actions={
          <div className="flex items-center gap-2.5 rounded-pill border border-border bg-bg px-4 py-2.5">
            <span className="text-meta text-muted">{t('overall')}</span>
            <Badge tone={TONE[health.status]} dot>
              {t(`health.${health.status}`)}
            </Badge>
          </div>
        }
      />

      {health.noPrimary ? (
        <Alert tone="danger" title={t('noPrimaryTitle')}>
          {t('noPrimaryBody')}
        </Alert>
      ) : null}

      <div className="flex flex-col gap-3">
        <h2 className="section-title">{t('actions')}</h2>
        {health.actions.length === 0 ? (
          <div className="card card-sm p-8 text-center text-sm text-muted">{t('actionsEmpty')}</div>
        ) : (
          <DataTable minWidth={860}>
            <thead>
              <tr>
                <th>{t('col.name')}</th>
                <th>{t('col.category')}</th>
                <th>{t('col.status')}</th>
                <th className="text-right">{t('col.dailyAvg')}</th>
                <th className="text-right">{t('col.sinceLast')}</th>
                <th>{t('col.issues')}</th>
              </tr>
            </thead>
            <tbody>
              {health.actions.map((a) => (
                <tr key={a.externalId}>
                  <td>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{a.name}</span>
                      <span className="text-xs text-faint">{primary.has(a.externalId) ? t('primary') : t('secondary')}</span>
                    </div>
                  </td>
                  <td className="text-muted">{categories.get(a.externalId) ?? '—'}</td>
                  <td>
                    <Badge tone={TONE[a.status]}>{t(`health.${a.status}`)}</Badge>
                  </td>
                  <td className="table-num">{formatNumber(a.dailyAverage, 1)}</td>
                  <td className={`table-num ${a.hoursSinceLast === null || a.hoursSinceLast > 72 ? 'text-warning' : ''}`}>{sinceLast(a.hoursSinceLast)}</td>
                  <td className={`text-meta ${a.issues.length ? 'text-warning' : 'text-faint'}`}>{a.issues.map((i) => i.message).join('；') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>

      <Card
        className="gap-[18px]"
        title={t('ga4')}
        subtitle={t('ga4Subtitle')}
        action={gap ? <Badge tone={gap.alert ? 'warn' : 'ok'}>{gap.alert ? t('drift') : t('stable')}</Badge> : null}
      >
        {gap ? (
          <>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4">
              <div className="panel gap-1">
                <span className="text-xs text-faint">GA4 property</span>
                <span className="font-mono text-ui">{account.ga4PropertyId}</span>
              </div>
              <div className="panel gap-1">
                <span className="text-xs text-faint">{t('baselineRatio')}</span>
                <span className="text-xl font-bold">{ratio(gap.baselineRatio)}</span>
              </div>
              <div className="panel gap-1">
                <span className="text-xs text-faint">{t('recentRatio')}</span>
                <span className={`text-xl font-bold ${gap.alert ? 'text-warning' : ''}`}>{ratio(gap.recentRatio)}</span>
              </div>
            </div>
            <p className="text-sm text-pretty text-muted">
              {gap.reason} <span className="text-faint">· {t('dataDays', { n: series.length })}</span>
            </p>
          </>
        ) : (
          <div className="panel text-sm">
            <span className="font-semibold">{t('ga4NotLinked')}</span>
            <span className="text-muted">{t('ga4NotLinkedBody')}</span>
          </div>
        )}
        {isAdmin ? (
          <form action={setGa4PropertyAction.bind(null, account.id)} className="flex flex-wrap items-start gap-2.5 border-t border-border pt-4">
            <div className="max-w-80 flex-[1_1_240px]">
              <Input
                label="GA4 property ID"
                size="sm"
                name="propertyId"
                defaultValue={account.ga4PropertyId ?? ''}
                placeholder={t('propertyPlaceholder')}
                className="font-mono"
                error={params.error === 'ga4' ? t('propertyError') : undefined}
                hint={t('propertyHint')}
              />
            </div>
            <div className="pt-[25px]">
              <Button variant="primary" size="sm">
                {account.ga4PropertyId ? t('update') : t('link')}
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-meta text-faint">{t('adminOnly')}</p>
        )}
      </Card>

      <div className="flex flex-col gap-3">
        <h2 className="section-title">{t('anomalies')}</h2>
        {anomalies.length === 0 ? <div className="card card-sm p-8 text-center text-sm text-muted">{t('anomaliesEmpty')}</div> : null}
        {anomalies.map((a) => (
          <div key={a.id} className="card card-sm flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-mono text-meta text-muted">{a.detectedOn.slice(5).replace('-', '/')}</span>
              <span className="font-semibold">{isMetric(a.metric) ? t(`metric.${a.metric}`) : a.metric}</span>
              <Badge tone={a.direction === 'up' ? 'warn' : 'bad'}>{a.direction === 'up' ? t('up') : t('down')}</Badge>
              <Badge>{a.segment || t('wholeAccount')}</Badge>
              <span className="ml-auto font-mono text-meta text-muted">
                {t('actualVsBaseline', { value: formatNumber(a.value, 2), baseline: formatNumber(a.baseline, 2), z: `${a.z > 0 ? '+' : '−'}${Math.abs(a.z).toFixed(1)}` })}
              </span>
            </div>
            {a.explanation ? (
              <div className="panel gap-1 px-4 py-3.5">
                <span className="eyebrow">{t('aiCause')}{a.explainedAt ? ` · ${formatAt(a.explainedAt, account.timezone)}` : ''}</span>
                <p className="text-sm text-pretty whitespace-pre-line">{a.explanation}</p>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}
