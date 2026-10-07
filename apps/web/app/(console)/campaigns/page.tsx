import { authorize } from '@arlo/core';
import { listCampaignTasks, resolveAccounts } from '@arlo/db';
import Link from 'next/link';
import { Badge, Button, Card, PageTitle, Table, Td } from '../../../components/ui';
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
      <PageTitle actions={canPropose ? <Link href="/campaigns/new"><Button>新增 Campaign brief</Button></Link> : null}>Campaign 工作區</PageTitle>
      <Card>
        {tasks.length === 0 ? (
          <p className="text-sm text-zinc-500">還沒有 campaign 任務。提交 brief 後，Campaign agent 會在背景產生 Search campaign 草稿。</p>
        ) : (
          <Table head={['Campaign', '帳戶', '狀態', '建立時間']}>
            {tasks.map((t) => (
              <tr key={t.id}>
                <Td first>
                  <Link href={`/campaigns/${t.id}`} className="font-medium hover:underline">
                    {t.brief.name}
                  </Link>
                </Td>
                <Td>{accountName.get(t.accountId)?.name ?? '—'}</Td>
                <Td>
                  <Badge tone={TASK_STATUS_TONE[t.status]}>{TASK_STATUS_LABEL[t.status]}</Badge>
                </Td>
                <Td className="whitespace-nowrap text-zinc-500">{formatAt(t.createdAt, accountName.get(t.accountId)?.timezone ?? 'UTC')}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
