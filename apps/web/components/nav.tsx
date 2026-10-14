'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Icon, type IconName } from './icons';

type NavKey = 'overview' | 'changesets' | 'searchTerms' | 'tracking' | 'campaigns' | 'automation' | 'schedules' | 'settings';

export const NAV_ITEMS: readonly { href: string; label: NavKey; icon: IconName }[] = [
  { href: '/', label: 'overview', icon: 'waveform' },
  { href: '/changesets', label: 'changesets', icon: 'check-circle' },
  { href: '/search-terms', label: 'searchTerms', icon: 'search' },
  { href: '/tracking', label: 'tracking', icon: 'code' },
  { href: '/campaigns', label: 'campaigns', icon: 'file' },
  { href: '/automation', label: 'automation', icon: 'zap' },
  { href: '/schedules', label: 'schedules', icon: 'calendar' },
  { href: '/settings', label: 'settings', icon: 'settings' },
];

// Second breadcrumb segment, most specific prefix first.
const SUB_LABELS = [
  [/^\/changesets\/.+/, 'changeset'],
  [/^\/campaigns\/new$/, 'newBrief'],
  [/^\/campaigns\/.+/, 'campaignTask'],
  [/^\/schedules\/new$/, 'newSchedule'],
  [/^\/schedules\/.+/, 'schedule'],
  [/^\/settings\/thresholds/, 'thresholds'],
  [/^\/settings\/business-profile/, 'businessProfile'],
  [/^\/settings\/rules/, 'rules'],
  [/^\/settings\/monitor/, 'monitor'],
  [/^\/settings\/users\/.+/, 'user'],
  [/^\/settings\/users/, 'users'],
] as const;

// Pages scoped to one ad account; they read it from `?account=`.
const ACCOUNT_PAGES = ['/', '/search-terms', '/tracking', '/settings/business-profile'];

const activeItem = (path: string) => NAV_ITEMS.find((i) => (i.href === '/' ? path === '/' : path.startsWith(i.href))) ?? NAV_ITEMS[0]!;

export function SidebarNav({ pendingReviews }: { pendingReviews: number }) {
  const t = useTranslations('nav');
  const active = activeItem(usePathname());
  return (
    <nav className="flex flex-row flex-wrap gap-0.5 md:flex-col">
      {NAV_ITEMS.map((i) => (
        <Link key={i.href} href={i.href} className="nav-item max-md:w-auto" aria-current={i === active ? 'page' : undefined}>
          <Icon name={i.icon} size={17} />
          <span className="flex-1">{t(i.label)}</span>
          {i.href === '/changesets' && pendingReviews > 0 ? <span className="badge px-2 py-0.5">{pendingReviews}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

export function SectionLabel() {
  const t = useTranslations('nav');
  const path = usePathname();
  const sub = SUB_LABELS.find(([re]) => re.test(path))?.[1];
  return <span className="text-sm font-semibold text-body">{t(activeItem(path).label) + (sub ? ` / ${t(`sub.${sub}`)}` : '')}</span>;
}

export interface SwitcherAccount {
  id: string;
  name: string;
  externalId: string;
  currency: string;
  timezone: string;
}

export function AccountSwitcher({ accounts }: { accounts: SwitcherAccount[] }) {
  const path = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const t = useTranslations('common');
  if (accounts.length === 0 || !ACCOUNT_PAGES.includes(path)) return null;
  const account = accounts.find((a) => a.id === params.get('account')) ?? accounts[0]!;
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="text-meta text-faint">{t('adAccount')}</span>
      <div className="select-wrap w-[220px]">
        <select
          className="input input-sm select"
          aria-label={t('adAccount')}
          value={account.id}
          // Switching accounts drops the other filters (campaign, search text): they belong to the old account.
          onChange={(e) => router.push(`${path}?account=${e.target.value}`)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <span className="select-chevron">
          <Icon name="chevron-down" size={16} />
        </span>
      </div>
      <span className="font-mono text-xs text-faint">
        {account.externalId} · {account.currency} · {account.timezone}
      </span>
    </div>
  );
}
