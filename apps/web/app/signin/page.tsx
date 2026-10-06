import { signIn } from '../../auth';

export const metadata = { title: '登入 · Arlo Ads Bot' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main>
      <h1>Arlo Ads Bot</h1>
      {error ? <p role="alert">無法登入：僅允許公司 Google Workspace 帳號。</p> : null}
      <form
        action={async () => {
          'use server';
          await signIn('google', { redirectTo: '/' });
        }}
      >
        <button type="submit">以 Google 帳號登入</button>
      </form>
    </main>
  );
}
