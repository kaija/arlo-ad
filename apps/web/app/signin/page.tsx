import { getTranslations } from 'next-intl/server';
import { signIn } from '../../auth';
import { LocaleSwitcher } from '../../components/locale-switcher';
import { Alert, Button, Logo } from '../../components/ui';

export async function generateMetadata() {
  return { title: (await getTranslations('signin'))('title') };
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const t = await getTranslations('signin');
  return (
    <main className="relative flex min-h-screen items-center justify-center bg-bg-secondary p-6">
      <LocaleSwitcher className="absolute top-5 right-5 w-[140px]" />
      <div className="card flex w-full max-w-[420px] flex-col items-center gap-5 text-center shadow-lg">
        <Logo size={44} />
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl leading-[1.2] font-bold tracking-[-0.02em]">{t('heading')}</h1>
          <p className="text-sm text-pretty text-muted">{t('intro')}</p>
        </div>
        {error ? (
          <div className="w-full text-left">
            <Alert tone="danger" title={t('errorTitle')}>
              {t('errorBody')}
            </Alert>
          </div>
        ) : null}
        <form
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: '/' });
          }}
        >
          <Button variant="primary">{t('button')}</Button>
        </form>
        <p className="text-xs text-faint">{t('footer')}</p>
      </div>
    </main>
  );
}
