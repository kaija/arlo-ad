'use client';

import { usePathname } from 'next/navigation';
import { NavLink } from './ui';

export const NAV_ITEMS = [
  { href: '/', label: '總覽' },
  { href: '/changesets', label: '審核' },
  { href: '/search-terms', label: '搜尋字詞' },
  { href: '/tracking', label: '追蹤' },
  { href: '/automation', label: '自動化' },
  { href: '/schedules', label: '排程' },
  { href: '/settings', label: '設定' },
] as const;

export function Nav({ items }: { items: readonly { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav className="flex flex-wrap gap-1">
      {items.map((i) => (
        <NavLink key={i.href} href={i.href} active={i.href === '/' ? path === '/' : path.startsWith(i.href)}>
          {i.label}
        </NavLink>
      ))}
    </nav>
  );
}
