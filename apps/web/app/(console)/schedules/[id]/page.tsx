import { authorize } from '@arlo/core';
import { getScheduledJob, listJobRuns } from '@arlo/db';
import { previewCron } from '@arlo/queue';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ConfirmAction } from '../../../../components/client';
import { ScheduleForm } from '../../../../components/schedule-form';
import { Alert, Badge, Button, DataTable, PageHeader } from '../../../../components/ui';
import { scheduleFormOptions } from '../../../../lib/schedule-page-data';
import { getDb } from '../../../../lib/server';
import { requireUser } from '../../../../lib/session';
import { deleteScheduleAction, runScheduleAction, saveScheduleAction } from '../actions';
import { formatAt, RUN_TONE } from '../../../../lib/time';

export const dynamic = 'force-dynamic';

export default async function SchedulePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; triggered?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const flags = await searchParams;
  const db = getDb();
  const job = /^[0-9a-f-]{36}$/.test(id) ? await getScheduledJob(db, id) : undefined;
  if (!job) notFound();
  const isAdmin = authorize(user, 'admin').allowed;
  const [runs, options] = await Promise.all([listJobRuns(db, { scheduledJobId: id, limit: 20 }), scheduleFormOptions(db)]);
  const next = previewCron(job.cron, job.tz, { count: 3 });
  const t = await getTranslations('schedule');
  const tc = await getTranslations('common');

  return (
    <>
      <PageHeader
        back={{ href: '/schedules', label: t('title') }}
        title={job.name}
        subtitle={t(`template.${job.template}`)}
        actions={
          isAdmin ? (
            <div className="flex gap-2.5">
              <form action={runScheduleAction.bind(null, job.id)}>
                <Button variant="secondary">{t('runNow')}</Button>
              </form>
              <ConfirmAction action={deleteScheduleAction.bind(null, job.id)} label={tc('delete')} title={t('deleteTitle', { name: job.name })}>
                {t('deleteBody')}
              </ConfirmAction>
            </div>
          ) : null
        }
      />
      {flags.saved ? <Alert tone="success" title={t('saved')} /> : null}
      {flags.triggered ? <Alert title={t('triggeredTitle')}>{t('triggeredBody')}</Alert> : null}
      {isAdmin ? null : <Alert title={t('readOnlyTitle')}>{t('readOnlyBody')}</Alert>}

      <div className="flex flex-wrap items-start gap-6">
        <ScheduleForm
          action={saveScheduleAction.bind(null, job.id)}
          initial={{
            name: job.name,
            template: job.template,
            cron: job.cron,
            tz: job.tz,
            accountIds: job.accountIds ?? [],
            channelId: (job.target as { channelId?: string }).channelId ?? '',
            extraInstructions: job.extraInstructions ?? '',
            enabled: job.enabled,
          }}
          readOnly={!isAdmin}
          {...options}
        />
        <div className="card card-sm flex flex-[1_1_280px] flex-col gap-2">
          <h3 className="mb-1 text-base font-semibold">{t('nextThree')}</h3>
          {job.enabled && next.ok ? (
            next.next.map((d) => (
              <div key={d.toISOString()} className="border-t border-border py-1.5 font-mono text-meta text-muted">
                {formatAt(d, job.tz)} ({job.tz})
              </div>
            ))
          ) : (
            <span className="text-meta text-faint">{job.enabled ? t('cronInvalid') : t('scheduleOff')}</span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="section-title">{t('runs')}</h2>
        {runs.length === 0 ? (
          <div className="card card-sm p-8 text-center text-sm text-muted">{t('runsEmpty')}</div>
        ) : (
          <DataTable minWidth={760}>
            <thead>
              <tr>
                <th>{t('run.startedAt')}</th>
                <th>{t('run.trigger')}</th>
                <th>{t('run.status')}</th>
                <th>{t('run.error')}</th>
                <th className="text-right">{t('run.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="table-num text-left">{formatAt(r.startedAt, job.tz)}</td>
                  <td className="text-muted">{r.trigger === 'manual' ? t('run.manual') : t('run.scheduled')}</td>
                  <td>
                    <Badge tone={RUN_TONE[r.status]}>{tc(`runStatus.${r.status}`)}</Badge>
                  </td>
                  <td className={`font-mono text-meta ${r.error ? 'text-danger' : 'text-faint'}`}>{r.error ?? '—'}</td>
                  <td className="table-num">{r.costUsd === null ? '—' : `$${r.costUsd.toFixed(4)}`}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
    </>
  );
}
