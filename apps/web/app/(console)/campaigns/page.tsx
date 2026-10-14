import { authorize } from '@arlo/core';
import { listCampaignTasks, resolveAccounts } from '@arlo/db';
import Link from 'next/link';
import { Badge, DataTable, EmptyState, LinkButton, PageHeader } from '../../../components/ui';
import { TASK_STATUS_LABEL, TASK_STATUS_TONE } from '../../../lib/campaigns';
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
  return (
    <>
      <PageHeader
        title="Campaign 工作區"
        subtitle="填寫 brief 後，AI 會在背景產生 Search campaign 草稿；核准後以暫停狀態建立。"
        actions={canPropose ? <LinkButton variant="primary" href="/campaigns/new">新增 Campaign brief</LinkButton> : null}
      />
      {tasks.length === 0 ? (
        <EmptyState icon="file" title="還沒有 campaign 任務">
          {canPropose ? '點「新增 Campaign brief」描述你的產品與目標，AI 會產生完整的 Search campaign 草稿。' : '有提案權限的成員建立 brief 後，任務會出現在這裡。'}
        </EmptyState>
      ) : (
        <DataTable minWidth={680}>
          <thead>
            <tr>
              <th>Campaign 名稱</th>
              <th>帳戶</th>
              <th>狀態</th>
              <th>建立時間</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td className="font-medium">
                  <Link href={`/campaigns/${t.id}`} className="hover:text-accent">
                    {t.brief.name}
                  </Link>
                </td>
                <td className="text-muted">{accountName.get(t.accountId)?.name ?? '—'}</td>
                <td>
                  <Badge tone={TASK_STATUS_TONE[t.status]} dot>
                    {TASK_STATUS_LABEL[t.status]}
                  </Badge>
                </td>
                <td className="table-num text-left">{formatAt(t.createdAt, accountName.get(t.accountId)?.timezone ?? 'UTC')}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </>
  );
}
