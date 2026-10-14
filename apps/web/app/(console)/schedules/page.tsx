import { authorize } from '@arlo/core';
import { latestRunsByJob, listScheduledJobs, resolveAccounts } from '@arlo/db';
import { previewCron } from '@arlo/queue';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { AutoSubmitForm } from '../../../components/client';
import { Badge, Button, DataTable, EmptyState, LinkButton, PageHeader, Switch } from '../../../components/ui';
import { getDb } from '../../../lib/server';
import { listBotChannels } from '../../../lib/slack-channels';
import { formatAt, RUN_TONE } from '../../../lib/time';
import { requireUser } from '../../../lib/session';
import { runScheduleAction, toggleScheduleAction } from './actions';

export const dynamic = 'force-dynamic';

// Schedules (Requirements 11.5, 18.4).
export default async function SchedulesPage() {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const db = getDb();
  const [jobs, runs, accounts, channels] = await Promise.all([listScheduledJobs(db), latestRunsByJob(db), resolveAccounts(db, { allowed: null }), listBotChannels()]);
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const channelName = new Map(channels.map((c) => [c.id, c.name]));
  const t = await getTranslations('schedule');
  const tc = await getTranslations('common');

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={isAdmin ? <LinkButton variant="primary" href="/schedules/new">{t('new')}</LinkButton> : null}
      />
      {jobs.length === 0 ? (
        <EmptyState icon="calendar" title={t('emptyTitle')}>
          {isAdmin ? t('emptyAdmin') : t('emptyViewer')}
        </EmptyState>
      ) : (
        <DataTable minWidth={1120}>
          <thead>
            <tr>
              <th>{t('col.name')}</th>
              <th>{t('col.template')}</th>
              <th>{t('col.time')}</th>
              <th>{t('col.accounts')}</th>
              <th>{t('col.channel')}</th>
              <th>{t('col.enabled')}</th>
              <th>{t('col.lastRun')}</th>
              {isAdmin ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const next = job.enabled ? previewCron(job.cron, job.tz, { count: 1 }) : null;
              const run = runs.get(job.id);
              const target = job.target as { channelId?: string };
              return (
                <tr key={job.id}>
                  <td>
                    <Link href={`/schedules/${job.id}`} className="font-medium hover:text-accent">
                      {job.name}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap text-muted">{t(`template.${job.template}`)}</td>
                  <td>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-mono text-meta">{job.cron}</span>
                      <span className="text-xs whitespace-nowrap text-faint">
                        {job.tz}
                        {next?.ok && next.next[0] ? ` · ${t('nextRun', { at: formatAt(next.next[0], job.tz) })}` : ''}
                      </span>
                    </div>
                  </td>
                  <td className="text-muted">{job.accountIds ? job.accountIds.map((id) => accountName.get(id) ?? id).join(', ') : t('allAccounts')}</td>
                  <td className="font-mono text-meta text-muted">#{channelName.get(target.channelId ?? '') ?? target.channelId}</td>
                  <td>
                    {isAdmin ? (
                      <AutoSubmitForm action={toggleScheduleAction.bind(null, job.id, !job.enabled)}>
                        <Switch size="sm" defaultChecked={job.enabled} aria-label={t('enableAria', { name: job.name })} />
                      </AutoSubmitForm>
                    ) : (
                      <Badge tone={job.enabled ? 'ok' : 'neutral'}>{job.enabled ? t('enabled') : t('disabled')}</Badge>
                    )}
                  </td>
                  <td>
                    {run ? (
                      <div className="flex flex-col items-start gap-[3px]">
                        <Badge tone={RUN_TONE[run.status]}>{tc(`runStatus.${run.status}`)}</Badge>
                        <span className="font-mono text-xs text-faint">{formatAt(run.startedAt, job.tz)}</span>
                      </div>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  {isAdmin ? (
                    <td>
                      <form action={runScheduleAction.bind(null, job.id)}>
                        <Button size="sm">{t('runNow')}</Button>
                      </form>
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
