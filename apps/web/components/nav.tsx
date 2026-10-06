'use client';

import { usePathname } from 'next/navigation';
import { NavLink } from './ui';

export const NAV_ITEMS = [
  { href: '/', label: '總覽' },
  { href: '/changesets', label: '審核' },
  { href: '/schedules', label: '排程' },
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
