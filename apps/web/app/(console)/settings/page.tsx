import { authorize } from '@arlo/core';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Alert, Icon, PageHeader, type IconName } from '../../../components/ui';
import { requireUser } from '../../../lib/session';

export const dynamic = 'force-dynamic';

const SECTIONS = [
  { href: '/settings/rules', key: 'rules', icon: 'check-circle' },
  { href: '/settings/monitor', key: 'monitor', icon: 'zap' },
  { href: '/settings/thresholds', key: 'thresholds', icon: 'filter' },
  { href: '/settings/business-profile', key: 'businessProfile', icon: 'file' },
  { href: '/settings/users', key: 'users', icon: 'user' },
  { href: '/schedules', key: 'schedules', icon: 'calendar' },
] as const satisfies readonly { href: string; key: string; icon: IconName }[];

// Settings hub (Requirement 18.4).
export default async function SettingsPage() {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const t = await getTranslations('settings');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {isAdmin ? null : <Alert title={t('readOnlyTitle')}>{t('readOnlyBody')}</Alert>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} className="card card-sm card-interactive flex flex-col gap-3">
            <span className="icon-tile">
              <Icon name={s.icon} size={20} />
            </span>
            <span className="text-base font-semibold tracking-[-0.01em]">{t(`section.${s.key}.title`)}</span>
            <span className="text-sm text-muted">{t(`section.${s.key}.text`)}</span>
            <span className="mt-auto text-meta text-accent">{isAdmin ? t('manage') : t('view')} →</span>
          </Link>
        ))}
      </div>
    </>
  );
}
