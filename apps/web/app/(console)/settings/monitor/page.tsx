import { authorize } from '@arlo/core';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { ConfirmAction } from '../../../../components/client';
import { Alert, Badge, DataTable, LinkButton, PageHeader } from '../../../../components/ui';
import { describeAction, describeMonitor } from '../../../../lib/monitor-rules';
import { getDb } from '../../../../lib/server';
import { readableAccounts, requireUser } from '../../../../lib/session';
import { monitorPageData } from '../../../../lib/settings-page-data';
import { deleteMonitorAction } from './actions';

export const dynamic = 'force-dynamic';

// Monitor rules (ADR-0017, Requirement 18.4).
export default async function MonitorRulesPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const { rules, accountName, campaignName, counts } = await monitorPageData(getDb(), readableAccounts(user));
  const { saved } = await searchParams;
  const t = await getTranslations('monitor');
  const ts = await getTranslations('settings');
  const tr = await getTranslations('rules');

  return (
    <>
      <PageHeader
        back={{ href: '/settings', label: ts('title') }}
        title={t('title')}
        subtitle={t('subtitle')}
        actions={isAdmin ? <LinkButton variant="primary" href="/settings/monitor/new">{t('new')}</LinkButton> : null}
      />
      {isAdmin ? null : <Alert title={ts('readOnlyTitle')}>{ts('readOnlyBody')}</Alert>}
      {saved ? <Alert tone="success" title={tr('saved')} /> : null}
      {rules.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 px-7 py-14 text-center">
          <h2 className="section-title">{t('emptyTitle')}</h2>
          <p className="text-sm text-muted">{t('emptyBody')}</p>
        </div>
      ) : (
        <DataTable minWidth={960}>
          <thead>
            <tr>
              <th>{t('col.type')}</th>
              <th>{t('col.condition')}</th>
              <th>{t('col.scope')}</th>
              <th>{t('col.action')}</th>
              <th>{t('col.cooldown')}</th>
              <th className="text-right">{t('col.triggers7d')}</th>
              <th>{t('col.enabled')}</th>
              {isAdmin ? <th className="w-12" /> : null}
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => {
              const label = t(`type.${r.spec.type}`);
              const d = describeMonitor(r.spec);
              const condition = t(`describe.${d.key}`, d.values);
              const a = describeAction(r.action);
              const scope = `${accountName.get(r.accountId) ?? ''}${r.campaignEntityId ? ` / ${campaignName.get(r.campaignEntityId) ?? 'campaign'}` : ''}`;
              return (
                <tr key={r.id} className={r.enabled ? undefined : 'opacity-55'}>
                  <td className="font-medium whitespace-nowrap">
                    {isAdmin ? (
                      <Link href={`/settings/monitor/${r.id}`} className="hover:text-accent">
                        {label}
                      </Link>
                    ) : (
                      label
                    )}
                  </td>
                  <td className="text-muted">{condition}</td>
                  <td className="whitespace-nowrap">{scope}</td>
                  <td className="whitespace-nowrap">{t(`describe.${a.key}`, a.values)}</td>
                  <td className="table-num text-left">{t('hours', { n: r.cooldownMinutes / 60 })}</td>
                  <td className="table-num">{counts.get(r.id) ?? 0}</td>
                  <td>
                    <Badge tone={r.enabled ? 'ok' : 'neutral'}>{r.enabled ? tr('enabled') : tr('disabled')}</Badge>
                  </td>
                  {isAdmin ? (
                    <td>
                      <ConfirmAction action={deleteMonitorAction.bind(null, r.id)} icon="trash" label={tr('deleteLabel')} title={tr('deleteTitle')}>
                        {tr('deleteBody', { label, condition, scope })}
                      </ConfirmAction>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </>
  );
}
