import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { auth, signOut } from '../../auth';

// Every console page requires a Workspace sign-in (Requirement 1.1).
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.arlo) redirect('/signin');

  return (
    <>
      <header>
        <span>{session.arlo.displayName ?? session.arlo.email}</span>
        <form
          action={async () => {
            'use server';
            await signOut({ redirectTo: '/signin' });
          }}
        >
          <button type="submit">登出</button>
        </form>
      </header>
      {children}
    </>
  );
}
