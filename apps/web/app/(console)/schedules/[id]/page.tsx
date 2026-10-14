import { authorize } from '@arlo/core';
import { getScheduledJob, listJobRuns } from '@arlo/db';
import { previewCron } from '@arlo/queue';
import { notFound } from 'next/navigation';
import { ConfirmAction } from '../../../../components/client';
import { ScheduleForm } from '../../../../components/schedule-form';
import { Alert, Badge, Button, DataTable, PageHeader } from '../../../../components/ui';
import { scheduleFormOptions } from '../../../../lib/schedule-page-data';
import { TEMPLATE_LABELS } from '../../../../lib/schedules';
import { getDb } from '../../../../lib/server';
import { requireUser } from '../../../../lib/session';
import { deleteScheduleAction, runScheduleAction, saveScheduleAction } from '../actions';
import { formatAt, RUN_LABEL, RUN_TONE } from '../../../../lib/time';

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
      <PageHeader
        back={{ href: '/schedules', label: '排程' }}
        title={job.name}
        subtitle={TEMPLATE_LABELS[job.template]}
        actions={
          isAdmin ? (
            <div className="flex gap-2.5">
              <form action={runScheduleAction.bind(null, job.id)}>
                <Button variant="secondary">立即執行</Button>
              </form>
              <ConfirmAction action={deleteScheduleAction.bind(null, job.id)} label="刪除" title={`刪除排程「${job.name}」？`}>
                刪除後不會再執行，執行紀錄會保留在稽核紀錄中。此動作無法復原。
              </ConfirmAction>
            </div>
          ) : null
        }
      />
      {flags.saved ? <Alert tone="success" title="已儲存" /> : null}
      {flags.triggered ? <Alert title="已送出手動執行">結果會發到目標 channel。</Alert> : null}
      {isAdmin ? null : <Alert title="唯讀">只有 Admin 可以修改排程。</Alert>}

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
          <h3 className="mb-1 text-base font-semibold">接下來三次執行</h3>
          {job.enabled && next.ok ? (
            next.next.map((d) => (
              <div key={d.toISOString()} className="border-t border-border py-1.5 font-mono text-meta text-muted">
                {formatAt(d, job.tz)} ({job.tz})
              </div>
            ))
          ) : (
            <span className="text-meta text-faint">{job.enabled ? 'cron 運算式無法解析。' : '排程已停用，不會自動執行。'}</span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="section-title">執行紀錄</h2>
        {runs.length === 0 ? (
          <div className="card card-sm p-8 text-center text-sm text-muted">還沒有執行紀錄。</div>
        ) : (
          <DataTable minWidth={760}>
            <thead>
              <tr>
                <th>開始時間</th>
                <th>觸發</th>
                <th>狀態</th>
                <th>錯誤訊息</th>
                <th className="text-right">LLM 成本（USD）</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="table-num text-left">{formatAt(r.startedAt, job.tz)}</td>
                  <td className="text-muted">{r.trigger === 'manual' ? '手動' : '排程'}</td>
                  <td>
                    <Badge tone={RUN_TONE[r.status]}>{RUN_LABEL[r.status]}</Badge>
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
