import { authorize } from '@arlo/core';
import { listCampaignTasks, resolveAccounts } from '@arlo/db';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Badge, DataTable, EmptyState, LinkButton, PageHeader } from '../../../components/ui';
import { TASK_STATUS_TONE } from '../../../lib/campaigns';
import { getDb } from '../../../lib/server';
import { readableAccounts, requireUser } from '../../../lib/session';
import { formatAt } from '../../../lib/time';

export const dynamic = 'force-dynamic';

// Campaign workspace (Requirements 15.1, 15.8, 18.5).
export default async function CampaignsPage() {
  const user = await requireUser();
  const db = getDb();
  const allowed = readableAccounts(user);
  const [tasks, accounts] = await Promise.all([listCampaignTasks(db, allowed), resolveAccounts(db, { allowed })]);
  const accountName = new Map(accounts.map((a) => [a.id, a]));
  const canPropose = accounts.some((a) => authorize(user, 'propose', { accountId: a.id }).allowed);
  const t = await getTranslations('campaign');
  return (
    <>
      <PageHeader
        title={t('list.title')}
        subtitle={t('list.subtitle')}
        actions={canPropose ? <LinkButton variant="primary" href="/campaigns/new">{t('list.new')}</LinkButton> : null}
      />
      {tasks.length === 0 ? (
        <EmptyState icon="file" title={t('list.emptyTitle')}>
          {canPropose ? t('list.emptyCanPropose') : t('list.emptyReadOnly')}
        </EmptyState>
      ) : (
        <DataTable minWidth={680}>
          <thead>
            <tr>
              <th>{t('list.colName')}</th>
              <th>{t('list.colAccount')}</th>
              <th>{t('list.colStatus')}</th>
              <th>{t('list.colCreated')}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td className="font-medium">
                  <Link href={`/campaigns/${task.id}`} className="hover:text-accent">
                    {task.brief.name}
                  </Link>
                </td>
                <td className="text-muted">{accountName.get(task.accountId)?.name ?? '—'}</td>
                <td>
                  <Badge tone={TASK_STATUS_TONE[task.status]} dot>
                    {t(`taskStatus.${task.status}`)}
                  </Badge>
                </td>
                <td className="table-num text-left">{formatAt(task.createdAt, accountName.get(task.accountId)?.timezone ?? 'UTC')}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </>
  );
}
