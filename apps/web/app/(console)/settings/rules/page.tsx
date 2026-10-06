import { authorize } from '@arlo/core';
import { listAllRules, listCampaigns, resolveAccounts, toRuleInstance } from '@arlo/db';
import Link from 'next/link';
import { Badge, Button, Card, PageTitle, Table, Td } from '../../../../components/ui';
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
      <PageTitle actions={isAdmin ? <Link href="/settings/rules/new"><Button>新增規則</Button></Link> : null}>Validator 規則</PageTitle>
      {saved ? <p className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">已儲存。</p> : null}
      <Card>
        {rows.length === 0 ? (
          <p className="text-sm text-zinc-500">還沒有規則。沒有規則時，所有變更只依 Tier 門檻分級。</p>
        ) : (
          <Table head={['規則', '條件', '範圍', '嚴重度', '狀態', '']}>
            {rows.map((row) => {
              const rule = toRuleInstance(row);
              const acc = row.accountId ? account.get(row.accountId) : undefined;
              const scope = row.scopeKind === 'org' ? '全組織' : row.scopeKind === 'account' ? (acc?.name ?? '帳戶') : `${acc?.name ?? ''} / ${campaign.get(row.campaignEntityId ?? '') ?? 'campaign'}`;
              return (
                <tr key={row.id}>
                  <Td first className="font-medium">
                    {isAdmin ? (
                      <Link href={`/settings/rules/${row.id}`} className="hover:underline">
                        {RULE_TYPE_LABEL[rule.spec.type]}
                      </Link>
                    ) : (
                      RULE_TYPE_LABEL[rule.spec.type]
                    )}
                  </Td>
                  <Td>{describeRule(rule.spec, acc?.currency)}</Td>
                  <Td>{scope}</Td>
                  <Td>{row.severity === 'HARD_BLOCK' ? <Badge tone="bad">阻擋</Badge> : <Badge tone="warn">警告</Badge>}</Td>
                  <Td>{row.enabled ? <Badge tone="ok">啟用</Badge> : <Badge>停用</Badge>}</Td>
                  <Td>
                    {isAdmin ? (
                      <form action={deleteRuleAction.bind(null, row.id)}>
                        <Button variant="secondary">刪除</Button>
                      </form>
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
