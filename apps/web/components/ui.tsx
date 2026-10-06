// Small Tailwind primitives in the shadcn/ui style (design.md「外部依賴」).
import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900', className)}>
      {title || actions ? (
        <header className="mb-3 flex items-center justify-between gap-2">
          {title ? <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">{title}</h2> : <span />}
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', tone === 'warn' && 'text-amber-600', tone === 'bad' && 'text-red-600')}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-zinc-500">{hint}</div> : null}
    </div>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' }) {
  const tones = {
    neutral: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
    ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    bad: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    info: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  };
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>;
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
            {head.map((h, i) => (
              <th key={i} className={cx('px-2 py-2 font-medium', i > 0 && 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, first, className }: { children: ReactNode; first?: boolean; className?: string }) {
  return <td className={cx('px-2 py-2 tabular-nums', !first && 'text-right', className)}>{children}</td>;
}

export function Button({ variant = 'primary', className, ...props }: ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const variants = {
    primary: 'bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300',
    secondary: 'border border-zinc-300 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800',
    danger: 'bg-red-600 text-white hover:bg-red-500',
  };
  return (
    <button
      className={cx('inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50', variants[variant], className)}
      {...props}
    />
  );
}

export function NavLink({ href, active, children }: { href: string; active?: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={cx(
        'rounded-md px-2.5 py-1.5 text-sm',
        active ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
      )}
    >
      {children}
    </Link>
  );
}

export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold">{children}</h1>
      {actions}
    </div>
  );
}

export const inputClass =
  'rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400';
