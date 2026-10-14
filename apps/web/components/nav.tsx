'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Icon, type IconName } from './icons';

export const NAV_ITEMS: readonly { href: string; label: string; icon: IconName }[] = [
  { href: '/', label: '總覽', icon: 'waveform' },
  { href: '/changesets', label: '審核', icon: 'check-circle' },
  { href: '/search-terms', label: '搜尋字詞', icon: 'search' },
  { href: '/tracking', label: '追蹤', icon: 'code' },
  { href: '/campaigns', label: 'Campaign', icon: 'file' },
  { href: '/automation', label: '自動化', icon: 'zap' },
  { href: '/schedules', label: '排程', icon: 'calendar' },
  { href: '/settings', label: '設定', icon: 'settings' },
];

// Second breadcrumb segment, most specific prefix first.
const SUB_LABELS: readonly [RegExp, string][] = [
  [/^\/changesets\/.+/, '變更單詳情'],
  [/^\/campaigns\/new$/, '新增 brief'],
  [/^\/campaigns\/.+/, '任務'],
  [/^\/schedules\/new$/, '新增排程'],
  [/^\/schedules\/.+/, '排程詳情'],
  [/^\/settings\/thresholds/, 'Tier 門檻'],
  [/^\/settings\/business-profile/, 'Business Profile'],
  [/^\/settings\/rules/, 'Validator 規則'],
  [/^\/settings\/monitor/, 'Monitor 熔斷規則'],
  [/^\/settings\/users\/.+/, '使用者詳情'],
  [/^\/settings\/users/, '使用者與權限'],
];

// Pages scoped to one ad account; they read it from `?account=`.
const ACCOUNT_PAGES = ['/', '/search-terms', '/tracking', '/settings/business-profile'];

const activeItem = (path: string) => NAV_ITEMS.find((i) => (i.href === '/' ? path === '/' : path.startsWith(i.href))) ?? NAV_ITEMS[0]!;

export function SidebarNav({ pendingReviews }: { pendingReviews: number }) {
  const active = activeItem(usePathname());
  return (
    <nav className="flex flex-row flex-wrap gap-0.5 md:flex-col">
      {NAV_ITEMS.map((i) => (
        <Link key={i.href} href={i.href} className="nav-item max-md:w-auto" aria-current={i === active ? 'page' : undefined}>
          <Icon name={i.icon} size={17} />
          <span className="flex-1">{i.label}</span>
          {i.href === '/changesets' && pendingReviews > 0 ? <span className="badge px-2 py-0.5">{pendingReviews}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

export function SectionLabel() {
  const path = usePathname();
  const sub = SUB_LABELS.find(([re]) => re.test(path))?.[1];
  return <span className="text-sm font-semibold text-body">{activeItem(path).label + (sub ? ` / ${sub}` : '')}</span>;
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
  if (accounts.length === 0 || !ACCOUNT_PAGES.includes(path)) return null;
  const account = accounts.find((a) => a.id === params.get('account')) ?? accounts[0]!;
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="text-meta text-faint">廣告帳戶</span>
      <div className="select-wrap w-[220px]">
        <select
          className="input input-sm select"
          aria-label="廣告帳戶"
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
