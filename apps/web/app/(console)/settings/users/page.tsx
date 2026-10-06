import { authorize } from '@arlo/core';
import { listUsersWithBindings, resolveAccounts } from '@arlo/db';
import Link from 'next/link';
import { Badge, Button, Card, inputClass, PageTitle, Table, Td } from '../../../../components/ui';
import { getDb } from '../../../../lib/server';
import { requireUser } from '../../../../lib/session';
import { ROLE_LABEL, STATUS_BADGE } from '../../../../lib/users';
import { addUserAction } from './actions';

export const dynamic = 'force-dynamic';

// Users and role bindings (ADR-0010, Requirements 1.3, 1.4, 18.4).
export default async function UsersPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const db = getDb();
  const [users, accounts] = await Promise.all([listUsersWithBindings(db), resolveAccounts(db, { allowed: null })]);
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const { error } = await searchParams;
  const unbound = users.filter((u) => u.status === 'unbound').length;

  return (
    <>
      <PageTitle
        actions={
          isAdmin ? (
            <form action={addUserAction} className="flex gap-2">
              <input name="email" type="email" placeholder="新增使用者 email" className={inputClass} required />
              <Button type="submit">新增</Button>
            </form>
          ) : null
        }
      >
        使用者與權限
      </PageTitle>
      {error ? <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{error}</p> : null}
      {unbound ? <p className="mb-4 text-sm text-amber-700 dark:text-amber-400">{unbound} 位使用者尚未綁定 Slack，無法在 Slack 使用 bot 或審核。</p> : null}
      <Card>
        <Table head={['使用者', '狀態', 'Slack', '權限']}>
          {users.map((u) => {
            const [tone, label] = STATUS_BADGE[u.status];
            return (
              <tr key={u.id}>
                <Td first>
                  {isAdmin ? (
                    <Link href={`/settings/users/${u.id}`} className="font-medium hover:underline">
                      {u.displayName ?? u.googleEmail}
                    </Link>
                  ) : (
                    <span className="font-medium">{u.displayName ?? u.googleEmail}</span>
                  )}
                  <div className="text-xs text-zinc-500">{u.googleEmail}</div>
                </Td>
                <Td>
                  <Badge tone={tone}>{label}</Badge>
                </Td>
                <Td>{u.slackUserId ? <code className="text-xs">{u.slackUserId}</code> : '—'}</Td>
                <Td>
                  {u.bindings.length === 0 ? (
                    <span className="text-zinc-500">無</span>
                  ) : (
                    <div className="space-y-0.5">
                      {u.bindings.map((b) => (
                        <div key={b.id} className="text-xs">
                          {ROLE_LABEL[b.role]}
                          {b.maxTier ? ` · ≤ Tier ${b.maxTier}` : ''} · {b.accountIds ? b.accountIds.map((id) => accountName.get(id) ?? id).join('、') : '全部帳戶'}
                        </div>
                      ))}
                    </div>
                  )}
                </Td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
