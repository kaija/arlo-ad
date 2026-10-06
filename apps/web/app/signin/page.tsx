import { signIn } from '../../auth';

export const metadata = { title: '登入 · Arlo Ads Bot' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-xl font-semibold">Arlo Ads Bot</h1>
        <p className="mt-1 text-sm text-zinc-500">Google Ads 管理 console</p>
        {error ? (
          <p role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            無法登入：僅允許公司 Google Workspace 帳號。
          </p>
        ) : null}
        <form
          className="mt-6"
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: '/' });
          }}
        >
          <button type="submit" className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900">
            以 Google 帳號登入
          </button>
        </form>
      </div>
    </main>
  );
}
