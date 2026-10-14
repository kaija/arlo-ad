import { authorize, formatMoney, formatNumber, formatPct } from '@arlo/core';
import { resolveAccounts } from '@arlo/db';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { AutoSubmitForm } from '../../../components/client';
import { Alert, Badge, DataTable, EmptyState, Icon, Input, LinkButton, PageHeader, PillTabs, Select } from '../../../components/ui';
import { STATUS_TONE } from '../../../lib/changesets';
import { isIntent, LABEL_FILTERS, loadSearchTerms, parseTermFilter } from '../../../lib/search-terms';
import { getDb } from '../../../lib/server';
import { readableAccounts, requireUser } from '../../../lib/session';
import { formatAt } from '../../../lib/time';

export const dynamic = 'force-dynamic';


// Search terms, classification and negative keyword history (Requirement 18.6).
export default async function SearchTermsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const db = getDb();
  const params = await searchParams;
  const accounts = await resolveAccounts(db, { allowed: readableAccounts(user) });
  const account = accounts.find((a) => a.id === params.account) ?? accounts[0];
  const t = await getTranslations('searchTerms');
  const tcs = await getTranslations('changeset');
  if (!account) {
    return (
      <>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <EmptyState icon="search" title={t('emptyNoAccountTitle')}>
          {t('emptyNoAccountBody')}
        </EmptyState>
      </>
    );
  }
  const filter = parseTermFilter(params);
  const { rows, profileVersion, history } = await loadSearchTerms(db, account, filter, new Date());
  const cur = account.currency;
  const isAdmin = authorize(user, 'admin').allowed;
  const profileHref = `/settings/business-profile?account=${account.id}`;
  const filtered = filter.label !== 'all' || !!filter.q;
  const href = (days: number) => `/search-terms?${new URLSearchParams({ account: account.id, days: String(days), label: filter.label, ...(filter.q ? { q: filter.q } : {}) }).toString()}`;

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      {profileVersion ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-bg px-4 py-3 text-sm">
          <Icon name="file" size={16} />
          <span>{t.rich('classifiedBy', { version: profileVersion, b: (chunks) => <strong className="font-semibold">{chunks}</strong> })}</span>
          <Link href={profileHref} className="link ml-auto">
            {isAdmin ? t('editProfile') : t('viewProfile')} →
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <Alert tone="warning" title={t('noProfileTitle')}>
            {t('noProfileBody')}
          </Alert>
          <div className="flex">
            <LinkButton size="sm" href={profileHref}>
              {isAdmin ? t('setProfile') : t('viewSettings')} →
            </LinkButton>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-[7px]">
          <span className="field-label">{t('period')}</span>
          <PillTabs tabs={([7, 30, 90] as const).map((d) => ({ href: href(d), label: t('lastDays', { days: d }), active: filter.days === d }))} />
        </div>
        <AutoSubmitForm method="get" className="contents">
          <input type="hidden" name="account" value={account.id} />
          <input type="hidden" name="days" value={filter.days} />
          <div className="w-[170px]">
            <Select label={t('classification')} size="sm" name="label" defaultValue={filter.label}>
              {LABEL_FILTERS.map((v) => (
                <option key={v} value={v}>
                  {t(`filter.${v}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="max-w-80 flex-[1_1_220px]">
            <Input label={t('search')} size="sm" icon="search" name="q" defaultValue={filter.q} placeholder={t('searchPlaceholder')} />
          </div>
        </AutoSubmitForm>
      </div>

      {rows.length === 0 ? (
        <div className="card flex flex-col items-center gap-2.5 px-7 py-14 text-center">
          <h2 className="section-title">{filtered ? t('emptyFilteredTitle') : t('emptyTitle')}</h2>
          <p className="max-w-[420px] text-sm text-muted">{filtered ? t('emptyFilteredBody') : t('emptyBody')}</p>
        </div>
      ) : (
        <DataTable minWidth={1080}>
          <thead>
            <tr>
              <th className="w-[34%]">{t('col.term')}</th>
              <th className="text-right">{t('col.cost')}</th>
              <th className="text-right">{t('col.clicks')}</th>
              <th className="text-right">{t('col.conversions90d')}</th>
              <th>{t('col.intent')}</th>
              <th className="text-right">{t('col.confidence')}</th>
              <th>{t('col.negative')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 300).map((r) => (
              <tr key={r.term}>
                <td>
                  <div className="flex flex-col gap-[3px]">
                    <span className="font-medium">{r.term}</span>
                    <span className="text-xs leading-normal text-pretty text-faint">{r.label ? r.label.reason : profileVersion ? t('awaitingScan') : t('noProfileReason')}</span>
                  </div>
                </td>
                <td className="table-num">{formatMoney(r.costMicros, cur)}</td>
                <td className="table-num">{formatNumber(r.clicks)}</td>
                <td className="table-num">{formatNumber(r.conversions90d, 1)}</td>
                <td>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge>{r.label ? (isIntent(r.label.intent) ? t(`intent.${r.label.intent}`) : r.label.intent) : t('unclassified')}</Badge>
                    {r.label ? <Badge tone={r.label.relevant ? 'ok' : 'bad'}>{r.label.relevant ? t('relevant') : t('irrelevant')}</Badge> : null}
                  </div>
                </td>
                <td className="table-num">{r.label ? formatPct(r.label.confidence, 0) : '—'}</td>
                <td className="whitespace-nowrap">
                  {r.negative ? (
                    <Link href={`/changesets/${r.negative.changesetId}`} className="link inline-flex items-center gap-1.5 text-meta">
                      <Badge tone={r.negative.excluded ? 'neutral' : STATUS_TONE[r.negative.status]}>{r.negative.excluded ? t('excluded') : tcs(`status.${r.negative.status}`)}</Badge>
                      <span className="font-mono">{r.negative.changesetId.slice(-8)}</span>
                    </Link>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <div className="mt-2 flex flex-col gap-3">
        <h2 className="section-title">{t('history')}</h2>
        {history.length === 0 ? (
          <div className="card card-sm p-8 text-center text-sm text-muted">{t('historyEmpty')}</div>
        ) : (
          <DataTable minWidth={640}>
            <thead>
              <tr>
                <th>{t('col.term')}</th>
                <th>{t('col.matchType')}</th>
                <th>{t('col.source')}</th>
                <th>{t('col.status')}</th>
                <th>{t('col.time')}</th>
              </tr>
            </thead>
            <tbody>
              {history.slice(0, 100).map((h, i) => (
                <tr key={`${h.changesetId}-${i}`}>
                  <td className="font-medium">{h.term}</td>
                  <td>
                    <span className="font-mono text-meta text-muted">{h.matchType}</span>
                  </td>
                  <td>{h.auto ? t('auto') : t('reviewed')}</td>
                  <td>
                    <Link href={`/changesets/${h.changesetId}`}>
                      <Badge tone={h.excluded ? 'neutral' : STATUS_TONE[h.status]}>{h.excluded ? t('excluded') : tcs(`status.${h.status}`)}</Badge>
                    </Link>
                  </td>
                  <td className="table-num text-left">{formatAt(h.createdAt, account.timezone)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
    </>
  );
}
