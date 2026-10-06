import { authorize } from '@arlo/core';
import { latestRunsByJob, listScheduledJobs, resolveAccounts } from '@arlo/db';
import { previewCron } from '@arlo/queue';
import Link from 'next/link';
import { Badge, Button, Card, PageTitle, Table, Td } from '../../../components/ui';
import { TEMPLATE_LABELS } from '../../../lib/schedules';
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

  return (
    <>
      <PageTitle actions={isAdmin ? <Link href="/schedules/new"><Button>新增排程</Button></Link> : null}>排程</PageTitle>
      <Card>
        {jobs.length === 0 ? (
          <p className="text-sm text-zinc-500">還沒有排程。{isAdmin ? '可以從「新增排程」建立每日報告。' : ''}</p>
        ) : (
          <Table head={['名稱', '模板', '時間', '帳戶', 'Channel', '狀態', '上次執行', '']}>
            {jobs.map((job) => {
              const next = job.enabled ? previewCron(job.cron, job.tz, { count: 1 }) : null;
              const run = runs.get(job.id);
              const target = job.target as { channelId?: string };
              return (
                <tr key={job.id}>
                  <Td first>
                    <Link href={`/schedules/${job.id}`} className="font-medium hover:underline">
                      {job.name}
                    </Link>
                  </Td>
                  <Td>{TEMPLATE_LABELS[job.template]}</Td>
                  <Td>
                    <code className="text-xs">{job.cron}</code>
                    <div className="text-xs text-zinc-500">
                      {job.tz}
                      {next?.ok && next.next[0] ? ` · 下次 ${formatAt(next.next[0], job.tz)}` : ''}
                    </div>
                  </Td>
                  <Td>{job.accountIds ? job.accountIds.map((id) => accountName.get(id) ?? id).join('、') : '全部'}</Td>
                  <Td>#{channelName.get(target.channelId ?? '') ?? target.channelId}</Td>
                  <Td>{job.enabled ? <Badge tone="ok">啟用</Badge> : <Badge>停用</Badge>}</Td>
                  <Td>
                    {run ? (
                      <span className="inline-flex items-center gap-1">
                        <Badge tone={RUN_TONE[run.status]}>{run.status}</Badge>
                        <span className="text-xs text-zinc-500">{formatAt(run.startedAt, job.tz)}</span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>
                    {isAdmin ? (
                      <span className="inline-flex gap-1">
                        <form action={runScheduleAction.bind(null, job.id)}>
                          <Button variant="secondary">立即執行</Button>
                        </form>
                        <form action={toggleScheduleAction.bind(null, job.id, !job.enabled)}>
                          <Button variant="secondary">{job.enabled ? '停用' : '啟用'}</Button>
                        </form>
                      </span>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
