import { authorize } from '@arlo/core';
import { getScheduledJob, listJobRuns } from '@arlo/db';
import { previewCron } from '@arlo/queue';
import { notFound } from 'next/navigation';
import { ScheduleForm } from '../../../../components/schedule-form';
import { Badge, Button, Card, PageTitle, Table, Td } from '../../../../components/ui';
import { scheduleFormOptions } from '../../../../lib/schedule-page-data';
import { TEMPLATE_LABELS } from '../../../../lib/schedules';
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

  return (
    <>
      <PageTitle
        actions={
          isAdmin ? (
            <span className="inline-flex gap-2">
              <form action={runScheduleAction.bind(null, job.id)}>
                <Button variant="secondary">立即執行</Button>
              </form>
              <form action={deleteScheduleAction.bind(null, job.id)}>
                <Button variant="danger">刪除</Button>
              </form>
            </span>
          ) : null
        }
      >
        {job.name} <span className="text-sm font-normal text-zinc-500">· {TEMPLATE_LABELS[job.template]}</span>
      </PageTitle>
      {flags.saved ? <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">已儲存。</p> : null}
      {flags.triggered ? <p className="mb-3 rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:bg-sky-950 dark:text-sky-300">已送出手動執行，結果會發到目標 channel。</p> : null}
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card title="設定">
          {isAdmin ? (
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
              {...options}
            />
          ) : (
            <p className="text-sm text-zinc-500">只有 admin 可以修改排程。</p>
          )}
        </Card>
        <div className="space-y-4">
          <Card title="接下來的執行">
            {job.enabled && next.ok ? (
              <ul className="space-y-1 text-sm">
                {next.next.map((d) => (
                  <li key={d.toISOString()}>{formatAt(d, job.tz)}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">已停用</p>
            )}
          </Card>
          <Card title="執行紀錄">
            <Table head={['開始', '狀態', '成本']}>
              {runs.map((r) => (
                <tr key={r.id}>
                  <Td first>
                    {formatAt(r.startedAt, job.tz)}
                    {r.trigger === 'manual' ? <span className="ml-1 text-xs text-zinc-500">手動</span> : null}
                    {r.error ? <div className="max-w-56 truncate text-xs text-red-600" title={r.error}>{r.error}</div> : null}
                  </Td>
                  <Td>
                    <Badge tone={RUN_TONE[r.status]}>{r.status}</Badge>
                  </Td>
                  <Td>{r.costUsd === null ? '—' : `$${r.costUsd.toFixed(4)}`}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      </div>
    </>
  );
}
