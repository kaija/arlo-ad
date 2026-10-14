import { authorize } from '@arlo/core';
import { listAllRules, listCampaigns, resolveAccounts, toRuleInstance } from '@arlo/db';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { ConfirmAction } from '../../../../components/client';
import { Alert, Badge, DataTable, LinkButton, PageHeader } from '../../../../components/ui';
import { describeRule } from '../../../../lib/rules';
import { getDb } from '../../../../lib/server';
import { requireUser } from '../../../../lib/session';
import { deleteRuleAction } from './actions';

export const dynamic = 'force-dynamic';

// Validator rules (Requirements 5.1, 5.2, 18.4).
export default async function RulesPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const db = getDb();
  const [rows, accounts] = await Promise.all([listAllRules(db), resolveAccounts(db, { allowed: null })]);
  const campaigns = await listCampaigns(db, accounts.map((a) => a.id));
  const account = new Map(accounts.map((a) => [a.id, a]));
  const campaign = new Map(campaigns.map((c) => [c.campaignId, c.name ?? c.externalId]));
  const { saved } = await searchParams;
  const t = await getTranslations('rules');
  const ts = await getTranslations('settings');

  return (
    <>
      <PageHeader
        back={{ href: '/settings', label: ts('title') }}
        title={t('title')}
        subtitle={t('subtitle')}
        actions={isAdmin ? <LinkButton variant="primary" href="/settings/rules/new">{t('new')}</LinkButton> : null}
      />
      {isAdmin ? null : <Alert title={ts('readOnlyTitle')}>{ts('readOnlyBody')}</Alert>}
      {saved ? <Alert tone="success" title={t('saved')} /> : null}
      {rows.length === 0 ? (
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
              <th>{t('col.severity')}</th>
              <th>{t('col.enabled')}</th>
              {isAdmin ? <th className="w-12" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const rule = toRuleInstance(row);
              const acc = row.accountId ? account.get(row.accountId) : undefined;
              const scope = row.scopeKind === 'org' ? t('scope.org') : row.scopeKind === 'account' ? (acc?.name ?? t('scope.account')) : `${acc?.name ?? ''} / ${campaign.get(row.campaignEntityId ?? '') ?? t('scope.campaign')}`;
              const label = t(`type.${rule.spec.type}`);
              const d = describeRule(rule.spec, acc?.currency);
              const condition = t(`describe.${d.key}`, d.values);
              return (
                <tr key={row.id} className={row.enabled ? undefined : 'opacity-55'}>
                  <td className="font-medium whitespace-nowrap">
                    {isAdmin ? (
                      <Link href={`/settings/rules/${row.id}`} className="hover:text-accent">
                        {label}
                      </Link>
                    ) : (
                      label
                    )}
                  </td>
                  <td className="text-muted">{condition}</td>
                  <td className="whitespace-nowrap">{scope}</td>
                  <td>
                    <Badge tone={row.severity === 'HARD_BLOCK' ? 'bad' : 'warn'}>{row.severity === 'HARD_BLOCK' ? t('block') : t('warn')}</Badge>
                  </td>
                  <td>
                    <Badge tone={row.enabled ? 'ok' : 'neutral'}>{row.enabled ? t('enabled') : t('disabled')}</Badge>
                  </td>
                  {isAdmin ? (
                    <td>
                      <ConfirmAction action={deleteRuleAction.bind(null, row.id)} icon="trash" label={t('deleteLabel')} title={t('deleteTitle')}>
                        {t('deleteBody', { label, condition, scope })}
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
