import { authorize } from '@arlo/core';
import { listAllRules, listCampaigns, resolveAccounts, toRuleInstance } from '@arlo/db';
import Link from 'next/link';
import { ConfirmAction } from '../../../../components/client';
import { Alert, Badge, DataTable, LinkButton, PageHeader } from '../../../../components/ui';
import { describeRule, RULE_TYPE_LABEL } from '../../../../lib/rules';
import { getDb } from '../../../../lib/server';
import { requireUser } from '../../../../lib/session';
import { deleteRuleAction } from './actions';

export const dynamic = 'force-dynamic';

// Validator rules (Requirements 5.1, 5.2, 18.4).
export default async function RulesPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const db = getDb();
  const [rows, accounts] = await Promise.all([listAllRules(db), resolveAccounts(db, { allowed: null })]);
  const campaigns = await listCampaigns(db, accounts.map((a) => a.id));
  const account = new Map(accounts.map((a) => [a.id, a]));
  const campaign = new Map(campaigns.map((c) => [c.campaignId, c.name ?? c.externalId]));
  const { saved } = await searchParams;

  return (
    <>
      <PageHeader
        back={{ href: '/settings', label: '設定' }}
        title="Validator 規則"
        subtitle="每筆變更單送審前都會檢查這些規則。「阻擋」規則未通過時任何人都不能核准；「警告」會把變更單升為需審核。"
        actions={isAdmin ? <LinkButton variant="primary" href="/settings/rules/new">新增規則</LinkButton> : null}
      />
      {isAdmin ? null : <Alert title="唯讀">所有設定只有 Admin 能修改，你目前可以檢視。</Alert>}
      {saved ? <Alert tone="success" title="已儲存" /> : null}
      {rows.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 px-7 py-14 text-center">
          <h2 className="section-title">還沒有規則</h2>
          <p className="text-sm text-muted">沒有規則時，所有變更只依 Tier 門檻分級。</p>
        </div>
      ) : (
        <DataTable minWidth={960}>
          <thead>
            <tr>
              <th>規則類型</th>
              <th>條件</th>
              <th>範圍</th>
              <th>嚴重度</th>
              <th>啟用</th>
              {isAdmin ? <th className="w-12" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const rule = toRuleInstance(row);
              const acc = row.accountId ? account.get(row.accountId) : undefined;
              const scope = row.scopeKind === 'org' ? '全組織' : row.scopeKind === 'account' ? (acc?.name ?? '帳戶') : `${acc?.name ?? ''} / ${campaign.get(row.campaignEntityId ?? '') ?? 'campaign'}`;
              const label = RULE_TYPE_LABEL[rule.spec.type];
              const condition = describeRule(rule.spec, acc?.currency);
              return (
                <tr key={row.id} className={row.enabled ? undefined : 'opacity-55'}>
                  <td className="font-medium whitespace-nowrap">
                    {isAdmin ? (
                      <Link href={`/settings/rules/${row.id}`} className="hover:text-accent">
                        {label}
                      </Link>
                    ) : (
                      label
                    )}
                  </td>
                  <td className="text-muted">{condition}</td>
                  <td className="whitespace-nowrap">{scope}</td>
                  <td>
                    <Badge tone={row.severity === 'HARD_BLOCK' ? 'bad' : 'warn'}>{row.severity === 'HARD_BLOCK' ? '阻擋' : '警告'}</Badge>
                  </td>
                  <td>
                    <Badge tone={row.enabled ? 'ok' : 'neutral'}>{row.enabled ? '啟用' : '停用'}</Badge>
                  </td>
                  {isAdmin ? (
                    <td>
                      <ConfirmAction action={deleteRuleAction.bind(null, row.id)} icon="trash" label="刪除規則" title="刪除這條規則？">
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
