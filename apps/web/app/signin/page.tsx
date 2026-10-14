import { signIn } from '../../auth';
import { Alert, Button, Logo } from '../../components/ui';

export const metadata = { title: '登入 · Arlo Ads Bot' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-secondary p-6">
      <div className="card flex w-full max-w-[420px] flex-col items-center gap-5 text-center shadow-lg">
        <Logo size={44} />
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl leading-[1.2] font-bold tracking-[-0.02em]">登入 Arlo Ads Bot</h1>
          <p className="text-sm text-pretty text-muted">Google Ads 管理 Agent 的 Web console。請使用公司 Google Workspace 帳號登入。</p>
        </div>
        {error ? (
          <div className="w-full text-left">
            <Alert tone="danger" title="無法登入">
              僅允許公司 Google Workspace 帳號，請改用公司帳號登入。
            </Alert>
          </div>
        ) : null}
        <form
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: '/' });
          }}
        >
          <Button variant="primary">以 Google 帳號登入</Button>
        </form>
        <p className="text-xs text-faint">登入即代表同意公司內部系統使用規範 · 所有操作皆留稽核紀錄</p>
      </div>
    </main>
  );
}
