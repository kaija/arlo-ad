import { authorize, ROLES } from '@arlo/core';
import { getUserWithBindings, resolveAccounts } from '@arlo/db';
import { getTranslations } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import { GrantForm } from '../../../../../components/grant-form';
import { Alert, Avatar, Badge, Button, Input, PageHeader } from '../../../../../components/ui';
import { getDb } from '../../../../../lib/server';
import { requireUser } from '../../../../../lib/session';
import { STATUS_TONE } from '../../../../../lib/users';
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
  const t = await getTranslations('users');
  const name = user.displayName ?? user.googleEmail;
  const isSelf = user.id === me.id;
  const disabled = user.status === 'disabled';

  return (
    <div className="flex max-w-[960px] flex-col gap-6">
      <PageHeader
        back={{ href: '/settings/users', label: t('title') }}
        title={
          <span className="flex flex-wrap items-center gap-4">
            <Avatar name={name} size="lg" />
            <span className="flex flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2.5">
                <span className="text-2xl">{name}</span>
                <Badge tone={STATUS_TONE[user.status]}>{t(`status.${user.status}`)}</Badge>
                {isSelf ? <Badge>{t('you')}</Badge> : null}
              </span>
              <span className="text-sm font-normal tracking-normal text-muted">{user.googleEmail}</span>
            </span>
          </span>
        }
      />
      {ok ? <Alert tone="success" title={ok} /> : null}
      {error ? (
        <Alert tone="danger" title={t('errorTitle')}>
          {error}
        </Alert>
      ) : null}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] items-start gap-5">
        <div className="card card-sm flex flex-col gap-3.5">
          <h2 className="text-base font-semibold">{t('slack')}</h2>
          {user.slackUserId ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-xs text-faint">{t('col.slack')}</span>
                <span className="font-mono">{user.slackUserId}</span>
              </div>
              {disabled ? null : (
                <form action={unbindSlackAction.bind(null, user.id)}>
                  <Button size="sm">{t('unbind')}</Button>
                </form>
              )}
            </div>
          ) : (
            <>
              <p className="text-meta text-muted">{t('notBound')}</p>
              {disabled ? null : (
                <>
                  <form action={bindSlackAction.bind(null, user.id)} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                    <Input size="sm" name="slackUserId" aria-label={t('col.slack')} placeholder="U04ABCDEF" className="font-mono" required />
                    <Button size="sm" variant="primary">
                      {t('bind')}
                    </Button>
                  </form>
                  <form action={lookupSlackAction.bind(null, user.id)} className="flex">
                    <Button size="sm">{t('lookup')}</Button>
                  </form>
                </>
              )}
            </>
          )}
        </div>

        <div className="card card-sm flex flex-col gap-3.5">
          <h2 className="text-base font-semibold">{t('accountStatus')}</h2>
          <p className="text-meta text-muted">{disabled ? t('disabledNote') : t('activeNote')}</p>
          <form action={setDisabledAction.bind(null, user.id, !disabled)} className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" disabled={isSelf}>
              {disabled ? t('reenable') : t('disable')}
            </Button>
            {isSelf ? <span className="text-meta text-faint">{t('cannotDisableSelf')}</span> : null}
          </form>
        </div>
      </div>

      <div className="card flex flex-col gap-4 px-7 py-6">
        <h2 className="section-title">{t('currentRoles')}</h2>
        {user.bindings.length === 0 ? (
          <Alert tone="warning" title={t('noRolesTitle')}>
            {t('noRolesBody')}
          </Alert>
        ) : null}
        {user.bindings.map((b) => (
          <div key={b.id} className="flex flex-wrap items-center gap-3 rounded-md border border-border px-4 py-3">
            <Badge tone="info">{t(`role.${b.role}`)}</Badge>
            <span className="text-sm">{b.maxTier ? t('upToTier', { tier: b.maxTier }) : t('cannotApprove')}</span>
            <span className="text-sm text-muted">{b.accountIds ? b.accountIds.map((aid) => accountName.get(aid) ?? aid).join(', ') : t('allAccounts')}</span>
            <form action={revokeAction.bind(null, user.id, b.id)} className="ml-auto">
              <Button size="sm">{t('remove')}</Button>
            </form>
          </div>
        ))}
        <GrantForm action={grantAction.bind(null, user.id)} roles={ROLES.map((r) => ({ value: r, label: t(`role.${r}`) }))} accounts={accounts.map((a) => ({ id: a.id, name: a.name }))} />
      </div>
    </div>
  );
}
