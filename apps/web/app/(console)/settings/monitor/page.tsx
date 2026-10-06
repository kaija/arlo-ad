import { authorize } from '@arlo/core';
import Link from 'next/link';
import { Badge, Button, Card, PageTitle, Table, Td } from '../../../../components/ui';
import { describeAction, describeMonitor, MONITOR_TYPE_LABEL } from '../../../../lib/monitor-rules';
import { getDb } from '../../../../lib/server';
import { readableAccounts, requireUser } from '../../../../lib/session';
import { monitorPageData } from '../../../../lib/settings-page-data';
import { deleteMonitorAction } from './actions';

export const dynamic = 'force-dynamic';

// Monitor rules (ADR-0017, Requirement 18.4).
export default async function MonitorRulesPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const { rules, accountName, campaignName, counts } = await monitorPageData(getDb(), readableAccounts(user));
  const { saved } = await searchParams;

  return (
    <>
      <PageTitle actions={isAdmin ? <Link href="/settings/monitor/new"><Button>新增 Monitor 規則</Button></Link> : null}>Monitor 熔斷規則</PageTitle>
      {saved ? <p className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">已儲存。</p> : null}
      <Card>
        {rules.length === 0 ? (
          <p className="text-sm text-zinc-500">還沒有 Monitor 規則。Monitor 每 15 分鐘（快照同步後）評估一次，不使用 LLM。</p>
        ) : (
          <Table head={['規則', '條件', '範圍', '動作', '冷卻', '7 天觸發', '狀態', '']}>
            {rules.map((r) => (
                <tr key={r.id}>
                  <Td first className="font-medium">
                    {isAdmin ? (
                      <Link href={`/settings/monitor/${r.id}`} className="hover:underline">
                        {MONITOR_TYPE_LABEL[r.spec.type]}
                      </Link>
                    ) : (
                      MONITOR_TYPE_LABEL[r.spec.type]
                    )}
                  </Td>
                  <Td>{describeMonitor(r.spec)}</Td>
                  <Td>
                    {accountName.get(r.accountId)}
                    {r.campaignEntityId ? ` / ${campaignName.get(r.campaignEntityId) ?? 'campaign'}` : ''}
                  </Td>
                  <Td>{describeAction(r.action)}</Td>
                  <Td>{r.cooldownMinutes / 60} 小時</Td>
                  <Td>{counts.get(r.id) ?? 0}</Td>
                  <Td>{r.enabled ? <Badge tone="ok">啟用</Badge> : <Badge>停用</Badge>}</Td>
                  <Td>
                    {isAdmin ? (
                      <form action={deleteMonitorAction.bind(null, r.id)}>
                        <Button variant="secondary">刪除</Button>
                      </form>
                    ) : null}
                  </Td>
                </tr>
              ))}
          </Table>
        )}
      </Card>
    </>
  );
}
