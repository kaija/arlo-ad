import { redirect } from 'next/navigation';
import { signOut } from '../../auth';
import { Alert, Button, Logo } from '../../components/ui';
import { requireSignedIn } from '../../lib/session';

export const metadata = { title: '等待審核 · Arlo Ads Bot' };

// Signed in but no role binding yet: hold here until an admin assigns one.
export default async function PendingPage() {
  const user = await requireSignedIn();
  if (user.bindings.length > 0) redirect('/');
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-secondary p-6">
      <div className="card flex w-full max-w-[420px] flex-col items-center gap-5 text-center shadow-lg">
        <Logo size={44} />
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl leading-[1.2] font-bold tracking-[-0.02em]">帳號等待審核</h1>
          <p className="text-sm text-pretty text-muted">
            已登入為 <span className="font-semibold text-body">{user.email}</span>，但尚未被指派角色。
          </p>
        </div>
        <div className="w-full text-left">
          <Alert title="需要 Admin 指派角色">請聯絡 Admin 在「設定 → 使用者」為你指派角色，完成後重新整理此頁即可進入。</Alert>
        </div>
        <div className="flex gap-3">
          {/* A server action re-renders from the server; a Link to the current URL would reuse the client cache. */}
          <form
            action={async () => {
              'use server';
              redirect('/');
            }}
          >
            <Button variant="primary">重新整理</Button>
          </form>
          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/signin' });
            }}
          >
            <Button>登出</Button>
          </form>
        </div>
      </div>
    </main>
  );
}
