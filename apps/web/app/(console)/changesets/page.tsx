import { CHANGESET_STATUSES } from '@arlo/core';
import Link from 'next/link';
import { Badge, Button, Card, inputClass, PageTitle, Table, Td } from '../../../components/ui';
import { loadQueue, parseQueueFilter, SOURCE_LABEL, STATUS_LABEL, STATUS_TONE } from '../../../lib/changesets';
import { getDb } from '../../../lib/server';
import { readableAccounts, requireUser } from '../../../lib/session';
import { formatAt } from '../../../lib/time';

export const dynamic = 'force-dynamic';

// Review queue (Requirement 18.3): every ChangeSet the user may read, filterable.
export default async function ChangeSetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const filter = parseQueueFilter(await searchParams);
  const { rows, accounts } = await loadQueue(getDb(), readableAccounts(user), filter);
  const tz = accounts[0]?.timezone ?? 'UTC';

  return (
    <>
      <PageTitle
        actions={
          <form className="flex flex-wrap items-center gap-2" method="get">
            <select name="status" defaultValue={filter.status ?? ''} className={inputClass} aria-label="狀態">
              <option value="">所有狀態</option>
              {CHANGESET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <select name="tier" defaultValue={filter.tier ?? ''} className={inputClass} aria-label="Tier">
              <option value="">所有 Tier</option>
              {[1, 2, 3].map((t) => (
                <option key={t} value={t}>
                  Tier {t}
                </option>
              ))}
            </select>
            <select name="account" defaultValue={filter.account ?? ''} className={inputClass} aria-label="帳戶">
              <option value="">所有帳戶</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <Button variant="secondary" type="submit">
              篩選
            </Button>
          </form>
        }
      >
        審核佇列
      </PageTitle>
      <Card>
        {rows.length === 0 ? (
          <p className="text-sm text-zinc-500">沒有符合條件的變更。</p>
        ) : (
          <Table head={['摘要', '帳戶', 'Tier', '狀態', '來源', '建立時間', '到期']}>
            {rows.map(({ cs, accountName }) => (
              <tr key={cs.id}>
                <Td first>
                  <Link href={`/changesets/${cs.id}`} className="font-medium hover:underline">
                    {cs.summary}
                  </Link>
                  {cs.violations.length ? <span className="ml-2 text-xs text-amber-600">⚠ {cs.violations.length}</span> : null}
                </Td>
                <Td>{accountName}</Td>
                <Td>{cs.tier === null ? '—' : `Tier ${cs.tier}`}</Td>
                <Td>
                  <Badge tone={STATUS_TONE[cs.status]}>{STATUS_LABEL[cs.status]}</Badge>
                </Td>
                <Td>{SOURCE_LABEL[cs.source.kind] ?? cs.source.kind}</Td>
                <Td className="whitespace-nowrap text-zinc-500">{formatAt(cs.createdAt, tz)}</Td>
                <Td className="whitespace-nowrap text-zinc-500">{cs.status === 'PENDING_APPROVAL' && cs.expiresAt ? formatAt(cs.expiresAt, tz) : '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
