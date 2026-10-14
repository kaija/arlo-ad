import { authorize } from '@arlo/core';
import { listUsersWithBindings, resolveAccounts } from '@arlo/db';
import Link from 'next/link';
import { Alert, Avatar, Badge, Button, DataTable, Input, PageHeader } from '../../../../components/ui';
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
      <PageHeader
        back={{ href: '/settings', label: '設定' }}
        title="使用者與權限"
        subtitle="角色：Viewer 檢視 · Operator 提案與 Undo · Approver 審核（有可審核的最高 Tier）· Admin 設定。權限可限定在特定帳戶。"
      />
      {isAdmin ? null : <Alert title="唯讀">只有 Admin 能新增使用者或調整權限。</Alert>}
      {unbound ? (
        <Alert tone="warning" title={`${unbound} 位使用者尚未綁定 Slack`}>
          未綁定的使用者無法在 Slack 收到審核通知，也無法在 Slack 核准變更單。
        </Alert>
      ) : null}
      {isAdmin ? (
        <form action={addUserAction} className="card card-sm flex flex-wrap items-start gap-3">
          <div className="max-w-[420px] flex-[1_1_280px]">
            <Input label="以 email 新增使用者" name="email" type="email" placeholder="name@company.com" hint="新增後預設沒有任何權限" error={error} required />
          </div>
          <div className="pt-[27px]">
            <Button variant="primary">新增</Button>
          </div>
        </form>
      ) : null}
      {users.length === 0 ? (
        <div className="card p-14 text-center text-sm text-muted">還沒有其他使用者。</div>
      ) : (
        <DataTable minWidth={880}>
          <thead>
            <tr>
              <th>使用者</th>
              <th>狀態</th>
              <th>Slack user ID</th>
              <th>權限</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const [tone, label] = STATUS_BADGE[u.status];
              const name = u.displayName ?? u.googleEmail;
              return (
                <tr key={u.id}>
                  <td>
                    <div className="flex items-center gap-3">
                      <Avatar name={name} size="sm" />
                      <div className="flex flex-col">
                        {isAdmin ? (
                          <Link href={`/settings/users/${u.id}`} className="font-medium hover:text-accent">
                            {name}
                          </Link>
                        ) : (
                          <span className="font-medium">{name}</span>
                        )}
                        <span className="text-meta text-faint">{u.googleEmail}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Badge tone={tone}>{label}</Badge>
                  </td>
                  <td className="font-mono text-meta text-muted">{u.slackUserId ?? '—'}</td>
                  <td>
                    <div className="flex flex-col gap-1">
                      {u.bindings.length === 0 ? <span className="text-meta text-warning">沒有任何權限</span> : null}
                      {u.bindings.map((b) => (
                        <span key={b.id} className="text-meta">
                          {ROLE_LABEL[b.role]}
                          {b.maxTier ? ` · 最高 Tier ${b.maxTier}` : ''} · {b.accountIds ? b.accountIds.map((id) => accountName.get(id) ?? id).join('、') : '全部帳戶'}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </>
  );
}
