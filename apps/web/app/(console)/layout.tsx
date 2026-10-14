import { authorize } from '@arlo/core';
import { listChangeSets, resolveAccounts } from '@arlo/db';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';
import { signOut } from '../../auth';
import { LocaleSwitcher } from '../../components/locale-switcher';
import { AccountSwitcher, SectionLabel, SidebarNav } from '../../components/nav';
import { Avatar, Badge, Button, Logo } from '../../components/ui';
import type { ArloSessionUser } from '../../lib/auth-config';
import { getDb } from '../../lib/server';
import { readableAccounts, requireUser } from '../../lib/session';

const ROLE_RANK = ['viewer', 'operator', 'approver', 'admin'] as const;
const ROLE_NAME = { viewer: 'Viewer', operator: 'Operator', approver: 'Approver', admin: 'Admin' } as const;

/** The user's highest role, with the tier ceiling for approvers. */
function roleSummary(user: ArloSessionUser, t: Awaited<ReturnType<typeof getTranslations<'console'>>>): { short: string; long: string } {
  const top = user.bindings.reduce<ArloSessionUser['bindings'][number] | null>((best, b) => (!best || ROLE_RANK.indexOf(b.role) > ROLE_RANK.indexOf(best.role) ? b : best), null);
  if (!top) return { short: t('noRoleShort'), long: t('noRoleLong') };
  const short = ROLE_NAME[top.role];
  return { short, long: top.role === 'approver' ? t('approverLong', { role: short, tier: top.maxTier }) : top.role === 'viewer' ? t('viewerLong', { role: short }) : short };
}

// Every console page requires a Workspace sign-in (Requirement 1.1).
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const db = getDb();
  const accounts = await resolveAccounts(db, { allowed: readableAccounts(user) });
  const pending = accounts.length ? await listChangeSets(db, { statuses: ['PENDING_APPROVAL'], accountIds: accounts.map((a) => a.id), limit: 100 }) : [];
  const t = await getTranslations('console');
  const tc = await getTranslations('common');
  const role = roleSummary(user, t);
  const name = user.displayName ?? user.email;
  const unbound = <Badge tone="warn" dot>{authorize(user, 'admin').allowed ? t('slackUnboundAdmin') : t('slackUnbound')}</Badge>;

  return (
    <div className="grid min-h-screen bg-bg-secondary md:grid-cols-[232px_minmax(0,1fr)]">
      <aside className="flex flex-col gap-6 border-border bg-bg px-3.5 py-[18px] max-md:border-b md:sticky md:top-0 md:h-screen md:overflow-y-auto md:border-r">
        <div className="flex items-center gap-2.5 px-2 py-1">
          <Logo size={28} />
          <div className="flex flex-col leading-[1.2]">
            <span className="text-ui font-semibold tracking-[-0.01em]">Arlo Ads Bot</span>
            <span className="text-xs text-faint">Web console</span>
          </div>
        </div>
        <SidebarNav pendingReviews={pending.length} />
        <div className="mt-auto flex flex-col gap-3 border-t border-border px-2.5 pt-3.5 pb-1">
          <div className="flex items-center gap-2.5">
            <Avatar name={name} size="sm" />
            <div className="flex min-w-0 flex-col leading-[1.3]">
              <span className="truncate text-sm font-semibold">{name}</span>
              <span className="truncate text-xs text-faint">{role.long}</span>
            </div>
          </div>
          {user.status === 'unbound' ? (
            authorize(user, 'admin').allowed ? (
              <Link href={`/settings/users/${user.id}`} className="flex" title={t('slackLinkTitle')}>
                {unbound}
              </Link>
            ) : (
              <span className="flex" title={t('slackAskAdmin')}>
                {unbound}
              </span>
            )
          ) : null}
          <LocaleSwitcher className="w-full" />
          <form
            className="flex"
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/signin' });
            }}
          >
            <Button size="sm">{tc('signOut')}</Button>
          </form>
        </div>
      </aside>

      <main className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-50 flex min-h-16 flex-wrap items-center gap-x-4 gap-y-3 border-b border-border bg-white/[0.82] px-5 py-2.5 backdrop-blur-[20px] backdrop-saturate-[180%] md:px-10">
          <Suspense>
            <SectionLabel />
            <div className="ml-auto flex flex-wrap items-center gap-3">
              <AccountSwitcher accounts={accounts.map((a) => ({ id: a.id, name: a.name, externalId: a.externalId, currency: a.currency, timezone: a.timezone }))} />
              <Badge>{role.short}</Badge>
            </div>
          </Suspense>
        </header>
        <div className="flex w-full max-w-[1360px] flex-col gap-6 px-5 pt-8 pb-20 md:px-10">{children}</div>
      </main>
    </div>
  );
}
