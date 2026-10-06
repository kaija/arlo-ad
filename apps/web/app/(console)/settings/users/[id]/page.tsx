import { authorize, ROLES } from '@arlo/core';
import { getUserWithBindings, resolveAccounts } from '@arlo/db';
import { notFound, redirect } from 'next/navigation';
import { Badge, Button, Card, inputClass, PageTitle, Table, Td } from '../../../../../components/ui';
import { getDb } from '../../../../../lib/server';
import { requireUser } from '../../../../../lib/session';
import { ROLE_LABEL, STATUS_BADGE } from '../../../../../lib/users';
import { bindSlackAction, grantAction, lookupSlackAction, revokeAction, setDisabledAction, unbindSlackAction } from '../actions';

export const dynamic = 'force-dynamic';

// One user's Slack binding, status and role bindings (Requirements 1.3, 1.4).
export default async function UserPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const me = await requireUser();
  if (!authorize(me, 'admin').allowed) redirect('/settings/users');
  const { id } = await params;
  const { ok, error } = await searchParams;
  const db = getDb();
  const user = /^[0-9a-f-]{36}$/i.test(id) ? await getUserWithBindings(db, id) : undefined;
  if (!user) notFound();
  const accounts = await resolveAccounts(db, { allowed: null });
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const [tone, label] = STATUS_BADGE[user.status];

  return (
    <>
      <PageTitle actions={<Badge tone={tone}>{label}</Badge>}>{user.displayName ?? user.googleEmail}</PageTitle>
      {ok ? <p className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">{ok}</p> : null}
      {error ? <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{error}</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Slack 綁定">
          <p className="mb-3 text-sm text-zinc-500">
            {user.googleEmail} · {user.slackUserId ? <>已綁定 <code>{user.slackUserId}</code></> : '尚未綁定：無法在 Slack 使用 bot 或審核。'}
          </p>
          {user.status !== 'disabled' ? (
            <div className="space-y-3">
              <form action={bindSlackAction.bind(null, user.id)} className="flex gap-2">
                <input name="slackUserId" defaultValue={user.slackUserId ?? ''} placeholder="Slack user ID（U0123ABCD）" className={`${inputClass} min-w-0 flex-1 font-mono`} required />
                <Button type="submit" variant="secondary">
                  手動綁定
                </Button>
              </form>
              <div className="flex gap-2">
                {!user.slackUserId ? (
                  <form action={lookupSlackAction.bind(null, user.id)}>
                    <Button type="submit" variant="secondary">
                      以 email 從 Slack 對應
                    </Button>
                  </form>
                ) : (
                  <form action={unbindSlackAction.bind(null, user.id)}>
                    <Button type="submit" variant="secondary">
                      解除綁定
                    </Button>
                  </form>
                )}
              </div>
            </div>
          ) : null}
          <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <form action={setDisabledAction.bind(null, user.id, user.status !== 'disabled')}>
              <Button type="submit" variant={user.status === 'disabled' ? 'secondary' : 'danger'} disabled={user.id === me.id}>
                {user.status === 'disabled' ? '重新啟用' : '停用使用者'}
              </Button>
            </form>
          </div>
        </Card>

        <Card title="新增權限">
          <form action={grantAction.bind(null, user.id)} className="space-y-3">
            <label className="block space-y-1">
              <span className="text-sm font-medium">角色</span>
              <select name="role" className={`${inputClass} w-full`} defaultValue="viewer">
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">可審核的最高 Tier（approver / admin）</span>
              <select name="maxTier" className={`${inputClass} w-full`} defaultValue="2">
                <option value="1">Tier 1</option>
                <option value="2">Tier 2</option>
                <option value="3">Tier 3</option>
              </select>
            </label>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">帳戶範圍</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="allAccounts" /> 全部帳戶（含之後新增的）
              </label>
              {accounts.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="accountIds" value={a.id} /> {a.name}
                </label>
              ))}
            </fieldset>
            <Button type="submit">新增權限</Button>
          </form>
        </Card>
      </div>

      <Card title="目前權限" className="mt-4">
        {user.bindings.length === 0 ? (
          <p className="text-sm text-zinc-500">沒有任何權限：登入後只能看到空白頁面。</p>
        ) : (
          <Table head={['角色', '可審核 Tier', '帳戶', '']}>
            {user.bindings.map((b) => (
              <tr key={b.id}>
                <Td first>{ROLE_LABEL[b.role]}</Td>
                <Td>{b.maxTier ? `≤ Tier ${b.maxTier}` : '—'}</Td>
                <Td>{b.accountIds ? b.accountIds.map((aid) => accountName.get(aid) ?? aid).join('、') : '全部帳戶'}</Td>
                <Td>
                  <form action={revokeAction.bind(null, user.id, b.id)}>
                    <Button type="submit" variant="secondary">
                      移除
                    </Button>
                  </form>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
