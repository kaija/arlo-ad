import { authorize, ROLES } from '@arlo/core';
import { getUserWithBindings, resolveAccounts } from '@arlo/db';
import { notFound, redirect } from 'next/navigation';
import { GrantForm } from '../../../../../components/grant-form';
import { Alert, Avatar, Badge, Button, Input, PageHeader } from '../../../../../components/ui';
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
  const name = user.displayName ?? user.googleEmail;
  const isSelf = user.id === me.id;
  const disabled = user.status === 'disabled';

  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <PageHeader
        back={{ href: '/settings/users', label: '使用者與權限' }}
        title={
          <span className="flex flex-wrap items-center gap-4">
            <Avatar name={name} size="lg" />
            <span className="flex flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2.5">
                <span className="text-2xl">{name}</span>
                <Badge tone={tone}>{label}</Badge>
                {isSelf ? <Badge>你</Badge> : null}
              </span>
              <span className="text-sm font-normal tracking-normal text-muted">{user.googleEmail}</span>
            </span>
          </span>
        }
      />
      {ok ? <Alert tone="success" title={ok} /> : null}
      {error ? <Alert tone="danger" title="無法完成">{error}</Alert> : null}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] items-start gap-5">
        <div className="card card-sm flex flex-col gap-3.5">
          <h2 className="text-base font-semibold">Slack 綁定</h2>
          {user.slackUserId ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-xs text-faint">Slack user ID</span>
                <span className="font-mono">{user.slackUserId}</span>
              </div>
              {disabled ? null : (
                <form action={unbindSlackAction.bind(null, user.id)}>
                  <Button size="sm">解除綁定</Button>
                </form>
              )}
            </div>
          ) : (
            <>
              <p className="text-meta text-muted">尚未綁定。綁定後才能在 Slack 收到通知與審核。</p>
              {disabled ? null : (
                <>
                  <form action={bindSlackAction.bind(null, user.id)} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                    <Input size="sm" name="slackUserId" aria-label="Slack user ID" placeholder="U04ABCDEF" className="font-mono" required />
                    <Button size="sm" variant="primary">
                      綁定
                    </Button>
                  </form>
                  <form action={lookupSlackAction.bind(null, user.id)} className="flex">
                    <Button size="sm">以 email 從 Slack 對應</Button>
                  </form>
                </>
              )}
            </>
          )}
        </div>

        <div className="card card-sm flex flex-col gap-3.5">
          <h2 className="text-base font-semibold">帳號狀態</h2>
          <p className="text-meta text-muted">{disabled ? '此帳號已停用，無法登入 console，也無法在 Slack 使用 bot。' : '帳號啟用中。停用後無法登入 console，也無法在 Slack 使用 bot。'}</p>
          <form action={setDisabledAction.bind(null, user.id, !disabled)} className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" disabled={isSelf}>
              {disabled ? '重新啟用' : '停用使用者'}
            </Button>
            {isSelf ? <span className="text-meta text-faint">不能停用自己</span> : null}
          </form>
        </div>
      </div>

      <div className="card flex flex-col gap-4 px-7 py-6">
        <h2 className="section-title">目前權限</h2>
        {user.bindings.length === 0 ? (
          <Alert tone="warning" title="沒有任何權限">
            此使用者登入後只會看到空白頁。請在下方新增至少一筆權限。
          </Alert>
        ) : null}
        {user.bindings.map((b) => (
          <div key={b.id} className="flex flex-wrap items-center gap-3 rounded-md border border-border px-4 py-3">
            <Badge tone="info">{ROLE_LABEL[b.role]}</Badge>
            <span className="text-sm">{b.maxTier ? `最高 Tier ${b.maxTier}` : '不可審核'}</span>
            <span className="text-sm text-muted">{b.accountIds ? b.accountIds.map((aid) => accountName.get(aid) ?? aid).join('、') : '全部帳戶'}</span>
            <form action={revokeAction.bind(null, user.id, b.id)} className="ml-auto">
              <Button size="sm">移除</Button>
            </form>
          </div>
        ))}
        <GrantForm action={grantAction.bind(null, user.id)} roles={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} accounts={accounts.map((a) => ({ id: a.id, name: a.name }))} />
      </div>
    </div>
  );
}
