import { CHANGESET_STATUSES } from '@arlo/core';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { AutoSubmitForm } from '../../../components/client';
import { Badge, DataTable, EmptyState, LinkButton, PageHeader, Select } from '../../../components/ui';
import { isSourceKind, loadQueue, parseQueueFilter, STATUS_TONE, tierTone } from '../../../lib/changesets';
import { getDb } from '../../../lib/server';
import { readableAccounts, requireUser } from '../../../lib/session';
import { formatAt } from '../../../lib/time';

export const dynamic = 'force-dynamic';

// Review queue (Requirement 18.3): every ChangeSet the user may read, filterable.
export default async function ChangeSetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const filter = parseQueueFilter(await searchParams);
  const { rows, accounts } = await loadQueue(getDb(), readableAccounts(user), filter);
  const zone = new Map(accounts.map((a) => [a.id, a.timezone]));
  const filtered = !!(filter.status || filter.tier !== undefined || filter.account);
  const pending = rows.filter((r) => r.cs.status === 'PENDING_APPROVAL').length;
  const t = await getTranslations('changeset');

  return (
    <>
      <PageHeader
        title={t('queue.title')}
        subtitle={t('queue.subtitle') + (pending ? ` ${t('queue.pendingCount', { count: pending })}` : '')}
        actions={
          <AutoSubmitForm method="get" className="flex flex-wrap gap-2.5">
            <div className="w-[180px]">
              <Select label={t('queue.status')} size="sm" name="status" defaultValue={filter.status ?? ''}>
                <option value="">{t('queue.allStatuses')}</option>
                {CHANGESET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`status.${s}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-[110px]">
              <Select label="Tier" size="sm" name="tier" defaultValue={filter.tier ?? ''}>
                <option value="">{t('queue.all')}</option>
                {[1, 2, 3].map((tier) => (
                  <option key={tier} value={tier}>
                    Tier {tier}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-[170px]">
              <Select label={t('queue.account')} size="sm" name="account" defaultValue={filter.account ?? ''}>
                <option value="">{t('queue.allAccounts')}</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
          </AutoSubmitForm>
        }
      />
      {rows.length === 0 ? (
        <EmptyState
          icon="check-circle"
          title={filtered ? t('queue.emptyFilteredTitle') : t('queue.emptyTitle')}
          action={filtered ? <LinkButton size="sm" href="/changesets">{t('queue.clearFilters')}</LinkButton> : null}
        >
          {filtered ? t('queue.emptyFilteredBody') : t('queue.emptyBody')}
        </EmptyState>
      ) : (
        <DataTable minWidth={1020}>
          <thead>
            <tr>
              <th>{t('queue.summary')}</th>
              <th>{t('queue.account')}</th>
              <th>Tier</th>
              <th>{t('queue.status')}</th>
              <th>{t('queue.source')}</th>
              <th>{t('queue.createdAt')}</th>
              <th>{t('queue.expiresAt')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ cs, accountName }) => {
              const tz = zone.get(cs.accountId) ?? 'UTC';
              return (
                <tr key={cs.id}>
                  <td>
                    <div className="flex flex-col gap-[3px]">
                      <Link href={`/changesets/${cs.id}`} className="font-medium hover:text-accent">
                        {cs.summary}
                      </Link>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-faint">{cs.id.slice(-8)}</span>
                        {cs.violations.length ? (
                          <Badge tone={cs.violations.some((v) => v.severity === 'HARD_BLOCK') ? 'bad' : 'warn'} className="px-2 py-0.5">
                            {t('queue.violations', { count: cs.violations.length })}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap">{accountName}</td>
                  <td>{cs.tier === null ? <span className="text-faint">—</span> : <Badge tone={tierTone(cs.tier)}>Tier {cs.tier}</Badge>}</td>
                  <td>
                    <Badge tone={STATUS_TONE[cs.status]} dot>
                      {t(`status.${cs.status}`)}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap text-muted">{isSourceKind(cs.source.kind) ? t(`source.${cs.source.kind}`) : cs.source.kind}</td>
                  <td className="table-num text-left">{formatAt(cs.createdAt, tz)}</td>
                  <td className="table-num text-left">{cs.status === 'PENDING_APPROVAL' && cs.expiresAt ? formatAt(cs.expiresAt, tz) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </>
  );
}
