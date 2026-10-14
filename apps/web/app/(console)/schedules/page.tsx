import { authorize } from '@arlo/core';
import { latestRunsByJob, listScheduledJobs, resolveAccounts } from '@arlo/db';
import { previewCron } from '@arlo/queue';
import Link from 'next/link';
import { AutoSubmitForm } from '../../../components/client';
import { Badge, Button, DataTable, EmptyState, LinkButton, PageHeader, Switch } from '../../../components/ui';
import { TEMPLATE_LABELS } from '../../../lib/schedules';
import { getDb } from '../../../lib/server';
import { listBotChannels } from '../../../lib/slack-channels';
import { formatAt, RUN_LABEL, RUN_TONE } from '../../../lib/time';
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

  return (
    <>
      <PageHeader
        title="排程"
        subtitle="定時讓 agent 執行任務，結果發到指定的 Slack channel。"
        actions={isAdmin ? <LinkButton variant="primary" href="/schedules/new">新增排程</LinkButton> : null}
      />
      {jobs.length === 0 ? (
        <EmptyState icon="calendar" title="還沒有排程">
          {isAdmin ? '點「新增排程」建立每日報告或否定關鍵字掃描。' : 'Admin 建立排程後會出現在這裡。'}
        </EmptyState>
      ) : (
        <DataTable minWidth={1120}>
          <thead>
            <tr>
              <th>名稱</th>
              <th>模板</th>
              <th>時間</th>
              <th>帳戶</th>
              <th>Slack channel</th>
              <th>啟用</th>
              <th>上次執行</th>
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
                  <td className="whitespace-nowrap text-muted">{TEMPLATE_LABELS[job.template]}</td>
                  <td>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-mono text-meta">{job.cron}</span>
                      <span className="text-xs whitespace-nowrap text-faint">
                        {job.tz}
                        {next?.ok && next.next[0] ? ` · 下次 ${formatAt(next.next[0], job.tz)}` : ''}
                      </span>
                    </div>
                  </td>
                  <td className="text-muted">{job.accountIds ? job.accountIds.map((id) => accountName.get(id) ?? id).join('、') : '全部帳戶'}</td>
                  <td className="font-mono text-meta text-muted">#{channelName.get(target.channelId ?? '') ?? target.channelId}</td>
                  <td>
                    {isAdmin ? (
                      <AutoSubmitForm action={toggleScheduleAction.bind(null, job.id, !job.enabled)}>
                        <Switch size="sm" defaultChecked={job.enabled} aria-label={`啟用 ${job.name}`} />
                      </AutoSubmitForm>
                    ) : (
                      <Badge tone={job.enabled ? 'ok' : 'neutral'}>{job.enabled ? '啟用' : '停用'}</Badge>
                    )}
                  </td>
                  <td>
                    {run ? (
                      <div className="flex flex-col items-start gap-[3px]">
                        <Badge tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]}</Badge>
                        <span className="font-mono text-xs text-faint">{formatAt(run.startedAt, job.tz)}</span>
                      </div>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  {isAdmin ? (
                    <td>
                      <form action={runScheduleAction.bind(null, job.id)}>
                        <Button size="sm">立即執行</Button>
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
