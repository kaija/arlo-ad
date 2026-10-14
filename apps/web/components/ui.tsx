// React primitives over the Arlo AI design system classes in app/globals.css. No hooks beyond
// useId, so they render in server components and client forms alike.
import Link from 'next/link';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export { Icon, Logo, type IconName } from './icons';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';
type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const btnClass = (variant?: 'primary' | 'secondary', size?: 'sm') => cx('btn', size === 'sm' && 'btn-sm', variant === 'primary' && 'btn-primary', variant === 'secondary' && 'btn-secondary');

export function Button({ variant, size, className, type = 'submit', ...props }: ComponentProps<'button'> & { variant?: 'primary' | 'secondary'; size?: 'sm' }) {
  return <button type={type} className={cx(btnClass(variant, size), className)} {...props} />;
}

export function LinkButton({ href, variant, size, className, children }: { href: string; variant?: 'primary' | 'secondary'; size?: 'sm'; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={cx(btnClass(variant, size), className)}>
      {children}
    </Link>
  );
}

const BADGE_TONE: Record<Tone, string | false> = { info: false, neutral: 'badge-neutral', ok: 'badge-success', warn: 'badge-warning', bad: 'badge-danger' };

export function Badge({ tone = 'neutral', dot, className, children }: { tone?: Tone; dot?: boolean; className?: string; children: ReactNode }) {
  return (
    <span className={cx('badge', BADGE_TONE[tone], className)}>
      {dot ? <span className="badge-dot" /> : null}
      {children}
    </span>
  );
}

export function Card({ title, subtitle, action, padding, className, children }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; padding?: 'sm'; className?: string; children: ReactNode }) {
  return (
    <section className={cx('card', padding === 'sm' ? 'card-sm' : 'px-7 py-6', 'flex flex-col gap-4', className)}>
      {title || action ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            {title ? <h2 className={padding === 'sm' ? 'text-base font-semibold' : 'section-title'}>{title}</h2> : null}
            {subtitle ? <span className="text-meta text-faint">{subtitle}</span> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, back, meta }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { href: string; label: string }; meta?: ReactNode }) {
  return (
    <>
      {back ? (
        <Link href={back.href} className="back-link self-start">
          ← {back.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          {meta}
          <h1 className="page-title text-pretty">{title}</h1>
          {subtitle ? <p className="max-w-[760px] text-sm text-muted">{subtitle}</p> : null}
        </div>
        {actions}
      </div>
    </>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-3 px-7 py-16 text-center">
      {icon ? (
        <span className="icon-tile">
          <Icon name={icon} size={22} />
        </span>
      ) : null}
      <h2 className="section-title">{title}</h2>
      {children ? <p className="max-w-[420px] text-sm text-pretty text-muted">{children}</p> : null}
      {action}
    </div>
  );
}

const ALERT_ICON: Record<AlertTone, IconName> = { info: 'info', success: 'check-circle', warning: 'alert-triangle', danger: 'alert-circle' };

export function Alert({ tone = 'info', title, children }: { tone?: AlertTone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={cx('alert', tone !== 'info' && `alert-${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="alert-icon">
        <Icon name={ALERT_ICON[tone]} size={18} />
      </span>
      <div>
        {title ? <div className="alert-title">{title}</div> : null}
        {children ? <div className="alert-body">{children}</div> : null}
      </div>
    </div>
  );
}

/** Scrollable table shell; pass `<thead>` / `<tbody>` as children. */
export function DataTable({ minWidth, className, children }: { minWidth?: number; className?: string; children: ReactNode }) {
  return (
    <div className={cx('table-wrap overflow-x-auto', className)}>
      <table className="table" style={minWidth ? { minWidth } : undefined}>
        {children}
      </table>
    </div>
  );
}

export function Field({ label, hint, error, htmlFor, children }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="field">
      {label ? (
        <label className="field-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {error || hint ? <p className={cx('field-hint', !!error && 'field-hint-error')}>{error || hint}</p> : null}
    </div>
  );
}

type FieldProps = { label?: ReactNode; hint?: ReactNode; error?: ReactNode; size?: 'sm' };

export function Input({ label, hint, error, size, icon, className, id, ...rest }: Omit<ComponentProps<'input'>, 'size'> & FieldProps & { icon?: IconName }) {
  const auto = useId();
  const inputId = id ?? auto;
  const field = <input id={inputId} className={cx('input', size === 'sm' && 'input-sm', !!error && 'input-error', className)} {...rest} />;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId}>
      {icon ? (
        <div className="input-wrap">
          <span className="input-icon">
            <Icon name={icon} size={16} />
          </span>
          {field}
        </div>
      ) : (
        field
      )}
    </Field>
  );
}

export function Textarea({ label, hint, error, size, className, id, ...rest }: ComponentProps<'textarea'> & FieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId}>
      <textarea id={inputId} className={cx('input', size === 'sm' && 'input-sm', !!error && 'input-error', className)} {...rest} />
    </Field>
  );
}

export function Select({ label, hint, error, size, className, id, children, ...rest }: Omit<ComponentProps<'select'>, 'size'> & FieldProps) {
  const auto = useId();
  const selectId = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={selectId}>
      <div className="select-wrap">
        <select id={selectId} className={cx('input select', size === 'sm' && 'input-sm', !!error && 'input-error', className)} {...rest}>
          {children}
        </select>
        <span className="select-chevron">
          <Icon name="chevron-down" size={16} />
        </span>
      </div>
    </Field>
  );
}

export function Checkbox({ label, disabled, ...rest }: Omit<ComponentProps<'input'>, 'type'> & { label?: ReactNode }) {
  return (
    <label className={cx('check', disabled && 'check-disabled')}>
      <input type="checkbox" disabled={disabled} {...rest} />
      <span className="check-box">
        <Icon className="check-tick" name="check" size={12} strokeWidth={3} />
      </span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}

export function Radio({ label, disabled, ...rest }: Omit<ComponentProps<'input'>, 'type'> & { label?: ReactNode }) {
  return (
    <label className={cx('check', disabled && 'check-disabled')}>
      <input type="radio" disabled={disabled} {...rest} />
      <span className="check-box check-box-round">
        <span className="check-dot" />
      </span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}

export function Switch({ label, size, disabled, ...rest }: Omit<ComponentProps<'input'>, 'type' | 'size'> & { label?: ReactNode; size?: 'sm' }) {
  return (
    <label className={cx('switch', size === 'sm' && 'switch-sm', disabled && 'check-disabled')}>
      <input type="checkbox" role="switch" disabled={disabled} {...rest} />
      <span className="switch-track">
        <span className="switch-knob" />
      </span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}

export function Avatar({ name, size }: { name: string; size?: 'sm' | 'lg' }) {
  const initials = name
    .trim()
    .split(/[\s@._-]+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
  return (
    <span className={cx('avatar', size && `avatar-${size}`)} title={name || undefined}>
      {initials}
    </span>
  );
}

export function Progress({ value, tone }: { value: number; tone?: 'success' | 'danger' }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)}>
      <div className={cx('progress-bar', tone && `progress-bar-${tone}`)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Pill segmented control whose segments are links (filters kept in the URL). */
export function PillTabs({ tabs }: { tabs: { href: string; label: string; active: boolean }[] }) {
  return (
    <div className="tabs tabs-pill self-start" role="tablist">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} role="tab" aria-selected={t.active} className="tab">
          {t.label}
        </Link>
      ))}
    </div>
  );
}
