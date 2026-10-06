'use client';

import { useActionState } from 'react';
import type { ThresholdFormState } from '../app/(console)/settings/thresholds/actions';
import type { ThresholdFormValues } from '../lib/rules';
import { Button, inputClass } from './ui';

export function ThresholdForm({
  action,
  initial: defaults,
  currency,
  disabled,
}: {
  action: (prev: ThresholdFormState, form: FormData) => Promise<ThresholdFormState>;
  initial: ThresholdFormValues;
  currency?: string;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const e = state.errors ?? {};
  const initial = state.values ?? defaults;
  const field = (name: keyof ThresholdFormValues, label: string, hint: string) => (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      <input name={name} defaultValue={initial[name]} inputMode="decimal" className={`${inputClass} w-full`} disabled={disabled} />
      {e[name] ? <span className="block text-xs text-red-600">{e[name]}</span> : <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
  return (
    <form key={JSON.stringify(initial)} action={formAction} className="grid gap-3 sm:grid-cols-4 sm:items-end">
      {field('tier1MaxReducePct', '自動執行的最大降幅（%）', '保護性變更在此幅度內為 Tier 1')}
      {field('tier3Pct', 'Tier 3 變動門檻（%）', '超過此比例需 Tier 3 確認')}
      {field('tier3Amount', `Tier 3 金額門檻${currency ? `（${currency}）` : ''}`, '每日預算變動超過此金額為 Tier 3；留空停用')}
      {disabled ? null : (
        <div className="flex items-center gap-2 pb-5">
          <Button type="submit" disabled={pending}>
            {pending ? '儲存中…' : '儲存'}
          </Button>
          {state.saved ? <span className="text-xs text-emerald-600">已儲存</span> : null}
        </div>
      )}
    </form>
  );
}
