import { authorize } from '@arlo/core';
import Link from 'next/link';
import { ConfirmAction } from '../../../../components/client';
import { Alert, Badge, DataTable, LinkButton, PageHeader } from '../../../../components/ui';
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
      <PageHeader
        back={{ href: '/settings', label: '設定' }}
        title="Monitor 熔斷規則"
        subtitle="花費超速、CPA 暴增時自動暫停或降預算。Monitor 每 15 分鐘（快照同步後）評估一次，不使用 LLM。"
        actions={isAdmin ? <LinkButton variant="primary" href="/settings/monitor/new">新增規則</LinkButton> : null}
      />
      {isAdmin ? null : <Alert title="唯讀">所有設定只有 Admin 能修改，你目前可以檢視。</Alert>}
      {saved ? <Alert tone="success" title="已儲存" /> : null}
      {rules.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 px-7 py-14 text-center">
          <h2 className="section-title">還沒有規則</h2>
          <p className="text-sm text-muted">新增熔斷規則後，Monitor 會在異常時自動止血並在 Slack 回報。</p>
        </div>
      ) : (
        <DataTable minWidth={960}>
          <thead>
            <tr>
              <th>規則類型</th>
              <th>條件</th>
              <th>範圍</th>
              <th>動作</th>
              <th>冷卻</th>
              <th className="text-right">7 天觸發</th>
              <th>啟用</th>
              {isAdmin ? <th className="w-12" /> : null}
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => {
              const label = MONITOR_TYPE_LABEL[r.spec.type];
              const condition = describeMonitor(r.spec);
              const scope = `${accountName.get(r.accountId) ?? ''}${r.campaignEntityId ? ` / ${campaignName.get(r.campaignEntityId) ?? 'campaign'}` : ''}`;
              return (
                <tr key={r.id} className={r.enabled ? undefined : 'opacity-55'}>
                  <td className="font-medium whitespace-nowrap">
                    {isAdmin ? (
                      <Link href={`/settings/monitor/${r.id}`} className="hover:text-accent">
                        {label}
                      </Link>
                    ) : (
                      label
                    )}
                  </td>
                  <td className="text-muted">{condition}</td>
                  <td className="whitespace-nowrap">{scope}</td>
                  <td className="whitespace-nowrap">{describeAction(r.action)}</td>
                  <td className="table-num text-left">{r.cooldownMinutes / 60} 小時</td>
                  <td className="table-num">{counts.get(r.id) ?? 0}</td>
                  <td>
                    <Badge tone={r.enabled ? 'ok' : 'neutral'}>{r.enabled ? '啟用' : '停用'}</Badge>
                  </td>
                  {isAdmin ? (
                    <td>
                      <ConfirmAction action={deleteMonitorAction.bind(null, r.id)} icon="trash" label="刪除規則" title="刪除這條規則？">
                        {label}：{condition}（{scope}）。刪除後立即生效，無法復原。
                      </ConfirmAction>
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
