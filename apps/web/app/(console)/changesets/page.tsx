import { CHANGESET_STATUSES } from '@arlo/core';
import Link from 'next/link';
import { AutoSubmitForm } from '../../../components/client';
import { Badge, DataTable, EmptyState, LinkButton, PageHeader, Select } from '../../../components/ui';
import { loadQueue, parseQueueFilter, SOURCE_LABEL, STATUS_LABEL, STATUS_TONE, tierTone } from '../../../lib/changesets';
import { getDb } from '../../../lib/server';
import { readableAccounts, requireUser } from '../../../lib/session';
import { formatAt } from '../../../lib/time';

export const dynamic = 'force-dynamic';

// Review queue (Requirement 18.3): every ChangeSet the user may read, filterable.
export default async function ChangeSetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const filter = parseQueueFilter(await searchParams);
  const { rows, accounts } = await loadQueue(getDb(), readableAccounts(user), filter);
  const zone = new Map(accounts.map((a) => [a.id, a.timezone]));
  const filtered = !!(filter.status || filter.tier !== undefined || filter.account);
  const pending = rows.filter((r) => r.cs.status === 'PENDING_APPROVAL').length;

  return (
    <>
      <PageHeader
        title="審核佇列"
        subtitle={`AI agent 提出的每一筆寫入都會成為變更單，經驗證、分級後在這裡審核。${pending ? `目前 ${pending} 筆待審核。` : ''}`}
        actions={
          <AutoSubmitForm method="get" className="flex flex-wrap gap-2.5">
            <div className="w-[150px]">
              <Select label="狀態" size="sm" name="status" defaultValue={filter.status ?? ''}>
                <option value="">全部狀態</option>
                {CHANGESET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-[110px]">
              <Select label="Tier" size="sm" name="tier" defaultValue={filter.tier ?? ''}>
                <option value="">全部</option>
                {[1, 2, 3].map((t) => (
                  <option key={t} value={t}>
                    Tier {t}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-[170px]">
              <Select label="帳戶" size="sm" name="account" defaultValue={filter.account ?? ''}>
                <option value="">全部帳戶</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
          </AutoSubmitForm>
        }
      />
      {rows.length === 0 ? (
        <EmptyState
          icon="check-circle"
          title={filtered ? '沒有符合篩選條件的變更單' : '目前沒有變更單'}
          action={filtered ? <LinkButton size="sm" href="/changesets">清除篩選</LinkButton> : null}
        >
          {filtered ? '試試調整狀態、Tier 或帳戶篩選。' : 'Agent 在 Slack、排程或 Monitor 提出變更後，會出現在這裡。'}
        </EmptyState>
      ) : (
        <DataTable minWidth={1020}>
          <thead>
            <tr>
              <th>摘要</th>
              <th>帳戶</th>
              <th>Tier</th>
              <th>狀態</th>
              <th>來源</th>
              <th>建立時間</th>
              <th>到期時間</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ cs, accountName }) => {
              const tz = zone.get(cs.accountId) ?? 'UTC';
              return (
                <tr key={cs.id}>
                  <td>
                    <div className="flex flex-col gap-[3px]">
                      <Link href={`/changesets/${cs.id}`} className="font-medium hover:text-accent">
                        {cs.summary}
                      </Link>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-faint">{cs.id.slice(-8)}</span>
                        {cs.violations.length ? (
                          <Badge tone={cs.violations.some((v) => v.severity === 'HARD_BLOCK') ? 'bad' : 'warn'} className="px-2 py-0.5">
                            {cs.violations.length} 項違規
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap">{accountName}</td>
                  <td>{cs.tier === null ? <span className="text-faint">—</span> : <Badge tone={tierTone(cs.tier)}>Tier {cs.tier}</Badge>}</td>
                  <td>
                    <Badge tone={STATUS_TONE[cs.status]} dot>
                      {STATUS_LABEL[cs.status]}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap text-muted">{SOURCE_LABEL[cs.source.kind] ?? cs.source.kind}</td>
                  <td className="table-num text-left">{formatAt(cs.createdAt, tz)}</td>
                  <td className="table-num text-left">{cs.status === 'PENDING_APPROVAL' && cs.expiresAt ? formatAt(cs.expiresAt, tz) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </>
  );
}
