import { addDays, formatMoney, formatPct } from '@arlo/core';
import { resolveAccounts } from '@arlo/db';
import { getTranslations } from 'next-intl/server';
import { CampaignTable } from '../../components/campaign-table';
import { AutoSubmitForm } from '../../components/client';
import { TrendChart } from '../../components/trend-chart';
import { Badge, Card, EmptyState, Input, LinkButton, PageHeader, Progress, type Tone } from '../../components/ui';
import { accountOverviews, campaignTable, trend } from '../../lib/dashboard';
import { getDb } from '../../lib/server';
import { readableAccounts, requireUser } from '../../lib/session';

export const dynamic = 'force-dynamic';

type Search = { account?: string; from?: string; to?: string; campaign?: string };
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const md = (date: string) => date.slice(5).replace('-', '/');

function StatCard({ label, value, hint, badge, children }: { label: string; value: string; hint: string; badge?: { tone: Tone; label: string }; children?: React.ReactNode }) {
  return (
    <div className="card card-sm flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-meta text-muted">{label}</span>
        {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
      </div>
      <span className="stat-value">{value}</span>
      <span className="text-meta text-faint">{hint}</span>
      {children}
    </div>
  );
}

// Overview (Requirement 18.1) and trend with change markers (Requirement 18.2).
export default async function OverviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const db = getDb();
  const params = await searchParams;
  const allowed = readableAccounts(user);
  const accounts = await resolveAccounts(db, { allowed });
  const t = await getTranslations('overview');
  if (accounts.length === 0) {
    return (
      <>
        <PageHeader title={t('title')} subtitle={t('noAccountsSubtitle')} />
        <EmptyState icon="waveform" title={t('noAccountsTitle')}>
          {t('noAccountsBody')}
        </EmptyState>
      </>
    );
  }
  const account = accounts.find((a) => a.id === params.account) ?? accounts[0]!;
  const [overview] = await accountOverviews(db, { allowed, account: account.id, now: new Date() });
  const o = overview!;
  const from = isDate(params.from) ? params.from! : o.monthStart;
  const to = isDate(params.to) ? params.to! : o.today;
  const rows = await campaignTable(db, { accountId: account.id, from, to });
  const selected = rows.find((r) => r.campaignId === params.campaign);
  const trendFrom = addDays(to, -29) < from ? addDays(to, -29) : from;
  const series = await trend(db, { account, from: trendFrom, to, campaignId: selected?.campaignId, externalCampaignId: selected?.externalId });
  const cur = account.currency;
  const capUse = o.monthlyCapMicros ? o.projectedMicros / o.monthlyCapMicros : null;
  const overPace = o.budgetPace !== null && o.budgetPace > 1.1;
  const query = (extra: Record<string, string | undefined>) =>
    `/?${new URLSearchParams(Object.entries({ account: account.id, from, to, ...extra }).filter((e): e is [string, string] => !!e[1])).toString()}`;

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle', { account: account.name, currency: cur, timezone: account.timezone })}
        actions={
          <AutoSubmitForm method="get" className="flex flex-wrap items-end gap-2.5">
            <input type="hidden" name="account" value={account.id} />
            {selected ? <input type="hidden" name="campaign" value={selected.campaignId} /> : null}
            <div className="w-40">
              <Input label={t('from')} type="date" size="sm" name="from" defaultValue={from} max={to} />
            </div>
            <div className="w-40">
              <Input label={t('to')} type="date" size="sm" name="to" defaultValue={to} />
            </div>
          </AutoSubmitForm>
        }
      />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-4">
        <StatCard label={t('mtdSpend')} value={formatMoney(o.mtdMicros, cur)} hint={t('dayOfMonth', { day: o.daysElapsed + 1, days: o.daysInMonth })}>
          <Progress value={(o.daysElapsed + 1) / o.daysInMonth} />
        </StatCard>
        <StatCard label={t('projectedSpend')} value={formatMoney(o.projectedMicros, cur)} hint={t('projectedHint', { linear: formatMoney(o.linearProjectedMicros, cur), daily: formatMoney(o.dailyRateMicros, cur) })} />
        <StatCard
          label={t('pacing')}
          value={formatPct(o.budgetPace, 1)}
          hint={t('pacingHint', { total: formatMoney(o.enabledBudgetMicros, cur) })}
          badge={o.budgetPace === null ? undefined : { tone: overPace ? 'warn' : 'ok', label: overPace ? t('overPace') : t('normal') }}
        />
        <StatCard
          label={t('monthlyCap')}
          value={o.monthlyCapMicros ? formatMoney(o.monthlyCapMicros, cur) : t('notSet')}
          hint={capUse === null ? t('capHintUnset') : t('capHint', { pct: formatPct(capUse, 1) })}
          badge={capUse === null ? { tone: 'neutral', label: t('notSet') } : capUse > 1 ? { tone: 'bad', label: t('overCap') } : capUse > 0.9 ? { tone: 'warn', label: t('nearCap') } : { tone: 'ok', label: t('normal') }}
        >
          {capUse === null ? null : <Progress value={capUse} tone={capUse > 1 ? 'danger' : 'success'} />}
        </StatCard>
      </div>

      <Card
        className="gap-5"
        title={selected ? t('campaignTrend', { name: selected.name ?? selected.externalId }) : t('accountTrend')}
        subtitle={t('trendSubtitle', { range: `${md(trendFrom)} – ${md(to)}` })}
        action={selected ? <LinkButton size="sm" href={query({})}>{t('backToAccount')}</LinkButton> : null}
      >
        <TrendChart currency={cur} points={series.points} markers={series.markers} />
      </Card>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="section-title">{t('campaigns')}</h2>
          <span className="text-meta text-faint">{t('tableHint', { range: `${md(from)} – ${md(to)}` })}</span>
        </div>
        {rows.length === 0 ? (
          <div className="card card-sm p-8 text-center text-sm text-muted">{t('noCampaigns')}</div>
        ) : (
          <CampaignTable rows={rows} currency={cur} selectedId={selected?.campaignId} hrefFor={(r) => query({ campaign: r.campaignId === selected?.campaignId ? undefined : r.campaignId })} />
        )}
      </div>
    </>
  );
}
