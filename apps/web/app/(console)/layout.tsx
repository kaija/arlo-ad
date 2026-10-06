import type { ReactNode } from 'react';
import { signOut } from '../../auth';
import { Nav, NAV_ITEMS } from '../../components/nav';
import { requireUser } from '../../lib/session';

// Every console page requires a Workspace sign-in (Requirement 1.1).
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-2">
          <span className="font-semibold">Arlo Ads Bot</span>
          <Nav items={NAV_ITEMS} />
          <div className="ml-auto flex items-center gap-3 text-sm text-zinc-500">
            <span>{user.displayName ?? user.email}</span>
            {user.status === 'unbound' ? <span title="尚未對應 Slack 帳號">（Slack 未綁定）</span> : null}
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/signin' });
              }}
            >
              <button type="submit" className="hover:underline">
                登出
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
