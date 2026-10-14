'use client';

// Small interactive pieces shared by console pages.
import { useTranslations } from 'next-intl';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { Button } from './ui';

/** A form that submits as soon as a select, checkbox, radio or date field changes. */
export function AutoSubmitForm({ children, ...props }: ComponentProps<'form'>) {
  return (
    <form
      {...props}
      onChange={(e) => {
        const t = e.target;
        if (t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && ['checkbox', 'radio', 'date'].includes(t.type))) e.currentTarget.requestSubmit();
      }}
    >
      {children}
    </form>
  );
}

/** A button that asks for confirmation in a dialog before running a server action. */
export function ConfirmAction({
  action,
  label,
  icon,
  title,
  confirmLabel,
  children,
}: {
  action: () => Promise<void>;
  label: string;
  /** Renders an icon-only trigger; `label` becomes its accessible name. */
  icon?: IconName;
  title: string;
  confirmLabel?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const t = useTranslations('common');
  return (
    <>
      {icon ? (
        <button type="button" className="icon-btn" aria-label={label} onClick={() => setOpen(true)}>
          <Icon name={icon} size={16} />
        </button>
      ) : (
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          {label}
        </Button>
      )}
      {open ? (
        <div className="dialog-overlay" onClick={() => setOpen(false)}>
          <div className="dialog text-left whitespace-normal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <h3 className="dialog-title">{title}</h3>
            </div>
            <div className="dialog-body">{children}</div>
            <form action={action} className="dialog-actions">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                {t('cancel')}
              </Button>
              <Button variant="primary">{confirmLabel ?? t('confirmDelete')}</Button>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Multi-select chips posted as repeated `name` fields. */
export function ChipSelect({ name, options, initial, disabled }: { name: string; options: { value: string; label: string }[]; initial: string[]; disabled?: boolean }) {
  const [picked, setPicked] = useState(initial);
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = picked.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            className={`tag tag-button ${on ? 'tag-accent' : ''}`}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => setPicked(on ? picked.filter((v) => v !== o.value) : [...picked, o.value])}
          >
            {o.label}
          </button>
        );
      })}
      {picked.map((v) => (
        <input key={v} type="hidden" name={name} value={v} />
      ))}
    </div>
  );
}
