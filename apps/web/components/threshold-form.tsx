'use client';

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
              已儲存
            </span>
          ) : null}
          {extra}
          {disabled ? null : (
            <Button size="sm" variant="primary" form={formId} disabled={pending}>
              {pending ? '儲存中…' : '儲存'}
            </Button>
          )}
        </div>
      </div>
      <form id={formId} key={JSON.stringify(initial)} action={formAction} className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
        <Input label="自動執行的最大降幅 %" size="sm" name="tier1MaxReducePct" defaultValue={initial.tier1MaxReducePct} inputMode="decimal" hint="降幅在此以內視為保護性變更（Tier 1）" error={e.tier1MaxReducePct} disabled={disabled} />
        <Input label="Tier 3 變動比例門檻 %" size="sm" name="tier3Pct" defaultValue={initial.tier3Pct} inputMode="decimal" hint="增減超過此比例升為 Tier 3" error={e.tier3Pct} disabled={disabled} />
        <Input
          label={`Tier 3 金額門檻${currency ? `（${currency}）` : ''}`}
          size="sm"
          name="tier3Amount"
          defaultValue={initial.tier3Amount}
          inputMode="decimal"
          placeholder="留空 = 停用"
          hint="每日預算變動金額超過此值升為 Tier 3"
          error={e.tier3Amount}
          disabled={disabled}
        />
      </form>
    </div>
  );
}
