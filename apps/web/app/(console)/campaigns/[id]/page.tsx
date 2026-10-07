import { formatMoney } from '@arlo/core';
import { getAdAccount, getCampaignTask, latestCampaignDraft } from '@arlo/db';
import { notFound } from 'next/navigation';
import { Badge, Card, PageTitle } from '../../../../components/ui';
import { TASK_STATUS_LABEL, TASK_STATUS_TONE } from '../../../../lib/campaigns';
import { getDb } from '../../../../lib/server';
import { readableAccounts, requireUser } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

// One campaign task: status, brief and the latest draft (Requirements 15.8, 18.5).
export default async function CampaignTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const db = getDb();
  const task = /^[0-9a-f-]{36}$/i.test(id) ? await getCampaignTask(db, id) : undefined;
  const allowed = readableAccounts(user);
  if (!task || (allowed !== null && !allowed.includes(task.accountId))) notFound();
  const [account, draft] = await Promise.all([getAdAccount(db, task.accountId), latestCampaignDraft(db, task.id)]);
  const b = task.brief;
  return (
    <>
      <PageTitle actions={<Badge tone={TASK_STATUS_TONE[task.status]}>{TASK_STATUS_LABEL[task.status]}</Badge>}>{b.name}</PageTitle>
      {task.status === 'queued' || task.status === 'running' ? <p className="mb-4 text-sm text-zinc-500">Campaign agent 正在背景產生草稿，通常需要一兩分鐘；重新整理頁面查看進度。</p> : null}
      {task.status === 'failed' ? <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">產生失敗：{task.error ?? '未知錯誤'}</p> : null}
      <Card title="Brief">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-zinc-500">帳戶</dt>
          <dd>{account?.name}</dd>
          <dt className="text-zinc-500">目標</dt>
          <dd className="whitespace-pre-line">{b.objective}</dd>
          <dt className="text-zinc-500">產品 / 賣點</dt>
          <dd className="whitespace-pre-line">{b.offering}</dd>
          <dt className="text-zinc-500">到達網頁</dt>
          <dd>{b.landingPageUrl}</dd>
          <dt className="text-zinc-500">預算</dt>
          <dd>{formatMoney(b.dailyBudget * 1_000_000, account?.currency ?? 'USD')} / 日</dd>
          <dt className="text-zinc-500">地區 / 語言</dt>
          <dd>
            {b.locations.join('、')} · {b.languages.join('、')}
          </dd>
          {b.audience ? (
            <>
              <dt className="text-zinc-500">受眾</dt>
              <dd>{b.audience}</dd>
            </>
          ) : null}
          {b.notes ? (
            <>
              <dt className="text-zinc-500">備註</dt>
              <dd className="whitespace-pre-line">{b.notes}</dd>
            </>
          ) : null}
        </dl>
      </Card>
      {draft ? (
        <Card title={`草稿 第 ${draft.version} 版`} className="mt-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {draft.draft.adGroups.length} 個廣告群組 · {draft.draft.adGroups.reduce((s, g) => s + g.keywords.length, 0)} 個關鍵字 · {draft.draft.negativeKeywords.length} 個否定關鍵字
          </p>
        </Card>
      ) : null}
    </>
  );
}
