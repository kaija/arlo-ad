import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { signOut } from '../../auth';
import { LocaleSwitcher } from '../../components/locale-switcher';
import { Alert, Button, Logo } from '../../components/ui';
import { requireSignedIn } from '../../lib/session';

export async function generateMetadata() {
  return { title: (await getTranslations('pending'))('title') };
}

// Signed in but no role binding yet: hold here until an admin assigns one.
export default async function PendingPage() {
  const user = await requireSignedIn();
  if (user.bindings.length > 0) redirect('/');
  const t = await getTranslations();
  return (
    <main className="relative flex min-h-screen items-center justify-center bg-bg-secondary p-6">
      <LocaleSwitcher className="absolute top-5 right-5 w-[140px]" />
      <div className="card flex w-full max-w-[420px] flex-col items-center gap-5 text-center shadow-lg">
        <Logo size={44} />
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl leading-[1.2] font-bold tracking-[-0.02em]">{t('pending.heading')}</h1>
          <p className="text-sm text-pretty text-muted">
            {t.rich('pending.signedInAs', { email: user.email, b: (chunks) => <span className="font-semibold text-body">{chunks}</span> })}
          </p>
        </div>
        <div className="w-full text-left">
          <Alert title={t('pending.alertTitle')}>{t('pending.alertBody')}</Alert>
        </div>
        <div className="flex gap-3">
          {/* A server action re-renders from the server; a Link to the current URL would reuse the client cache. */}
          <form
            action={async () => {
              'use server';
              redirect('/');
            }}
          >
            <Button variant="primary">{t('pending.refresh')}</Button>
          </form>
          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/signin' });
            }}
          >
            <Button>{t('common.signOut')}</Button>
          </form>
        </div>
      </div>
    </main>
  );
}
