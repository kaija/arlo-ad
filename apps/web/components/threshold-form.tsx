'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useId, type ReactNode } from 'react';
import type { ThresholdFormState } from '../app/(console)/settings/thresholds/actions';
import type { ThresholdFormValues } from '../lib/rules';
import { Icon } from './icons';
import { Button, Input } from './ui';

/** One threshold card: title and save state in the header, the three limits below. */
export function ThresholdForm({
  action,
  initial: defaults,
  title,
  meta,
  extra,
  currency,
  disabled,
}: {
  action: (prev: ThresholdFormState, form: FormData) => Promise<ThresholdFormState>;
  initial: ThresholdFormValues;
  title: string;
  meta: string;
  /** Extra header control, e.g. "revert to default". */
  extra?: ReactNode;
  currency?: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const e = state.errors ?? {};
  const initial = state.values ?? defaults;
  const formId = useId();
  const t = useTranslations('thresholds');
  const tc = useTranslations('common');
  return (
    <div className="card card-sm flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-semibold">{title}</span>
          <span className="font-mono text-xs text-faint">{meta}</span>
        </div>
        <div className="flex items-center gap-2.5">
          {state.saved ? (
            <span className="flex items-center gap-1.5 text-meta text-success">
              <Icon name="check" size={14} />
              {t('saved')}
            </span>
          ) : null}
          {extra}
          {disabled ? null : (
            <Button size="sm" variant="primary" form={formId} disabled={pending}>
              {pending ? tc('saving') : tc('save')}
            </Button>
          )}
        </div>
      </div>
      <form id={formId} key={JSON.stringify(initial)} action={formAction} className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
        <Input label={t('tier1MaxReduce')} size="sm" name="tier1MaxReducePct" defaultValue={initial.tier1MaxReducePct} inputMode="decimal" hint={t('tier1MaxReduceHint')} error={e.tier1MaxReducePct} disabled={disabled} />
        <Input label={t('tier3Pct')} size="sm" name="tier3Pct" defaultValue={initial.tier3Pct} inputMode="decimal" hint={t('tier3PctHint')} error={e.tier3Pct} disabled={disabled} />
        <Input
          label={currency ? t('tier3AmountWithCurrency', { currency }) : t('tier3Amount')}
          size="sm"
          name="tier3Amount"
          defaultValue={initial.tier3Amount}
          inputMode="decimal"
          placeholder={t('tier3AmountPlaceholder')}
          hint={t('tier3AmountHint')}
          error={e.tier3Amount}
          disabled={disabled}
        />
      </form>
    </div>
  );
}
