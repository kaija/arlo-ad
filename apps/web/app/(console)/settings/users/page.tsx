import { authorize } from '@arlo/core';
import { listUsersWithBindings, resolveAccounts } from '@arlo/db';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Alert, Avatar, Badge, Button, DataTable, Input, PageHeader } from '../../../../components/ui';
import { getDb } from '../../../../lib/server';
import { requireUser } from '../../../../lib/session';
import { STATUS_TONE } from '../../../../lib/users';
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
  const t = await getTranslations('users');
  const ts = await getTranslations('settings');

  return (
    <>
      <PageHeader
        back={{ href: '/settings', label: ts('title') }}
        title={t('title')}
        subtitle={t('subtitle')}
      />
      {isAdmin ? null : <Alert title={t('readOnlyTitle')}>{t('readOnlyBody')}</Alert>}
      {unbound ? (
        <Alert tone="warning" title={t('unboundTitle', { count: unbound })}>
          {t('unboundBody')}
        </Alert>
      ) : null}
      {isAdmin ? (
        <form action={addUserAction} className="card card-sm flex flex-wrap items-start gap-3">
          <div className="max-w-[420px] flex-[1_1_280px]">
            <Input label={t('addByEmail')} name="email" type="email" placeholder="name@company.com" hint={t('addHint')} error={error} required />
          </div>
          <div className="pt-[27px]">
            <Button variant="primary">{t('add')}</Button>
          </div>
        </form>
      ) : null}
      {users.length === 0 ? (
        <div className="card p-14 text-center text-sm text-muted">{t('noUsers')}</div>
      ) : (
        <DataTable minWidth={880}>
          <thead>
            <tr>
              <th>{t('col.user')}</th>
              <th>{t('col.status')}</th>
              <th>{t('col.slack')}</th>
              <th>{t('col.roles')}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {

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
                    <Badge tone={STATUS_TONE[u.status]}>{t(`status.${u.status}`)}</Badge>
                  </td>
                  <td className="font-mono text-meta text-muted">{u.slackUserId ?? '—'}</td>
                  <td>
                    <div className="flex flex-col gap-1">
                      {u.bindings.length === 0 ? <span className="text-meta text-warning">{t('noRoles')}</span> : null}
                      {u.bindings.map((b) => (
                        <span key={b.id} className="text-meta">
                          {t(`role.${b.role}`)}
                          {b.maxTier ? ` · ${t('upToTier', { tier: b.maxTier })}` : ''} · {b.accountIds ? b.accountIds.map((id) => accountName.get(id) ?? id).join(', ') : t('allAccounts')}
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
