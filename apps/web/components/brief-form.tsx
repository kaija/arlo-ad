'use client';

import { useActionState } from 'react';
import type { BriefFormState } from '../app/(console)/campaigns/actions';
import type { BriefFormValues } from '../lib/campaigns';
import { Button, inputClass } from './ui';

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error ? <span className="block text-xs text-red-600">{error}</span> : hint ? <span className="block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

export function BriefForm({ action, initial: defaults, accounts }: { action: (prev: BriefFormState, form: FormData) => Promise<BriefFormState>; initial: BriefFormValues; accounts: { id: string; name: string; currency: string }[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const e = state.errors ?? {};
  const v = state.values ?? defaults;
  return (
    <form key={JSON.stringify(v)} action={formAction} className="grid max-w-3xl gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="帳戶" error={e.accountId}>
          <select name="accountId" defaultValue={v.accountId} className={`${inputClass} w-full`}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}（{a.currency}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="Campaign 名稱" error={e.name}>
          <input name="name" defaultValue={v.name} className={`${inputClass} w-full`} required />
        </Field>
      </div>
      <Field label="目標" error={e.objective} hint="例如：Q4 新品預購、提高視訊門鈴的線上銷售">
        <textarea name="objective" defaultValue={v.objective} rows={2} className={`${inputClass} w-full`} required />
      </Field>
      <Field label="產品 / 服務與賣點" error={e.offering}>
        <textarea name="offering" defaultValue={v.offering} rows={4} className={`${inputClass} w-full`} required />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="到達網頁" error={e.landingPageUrl}>
          <input name="landingPageUrl" defaultValue={v.landingPageUrl} placeholder="https://" className={`${inputClass} w-full`} required />
        </Field>
        <Field label="每日預算（帳戶幣別）" error={e.dailyBudget}>
          <input name="dailyBudget" defaultValue={v.dailyBudget} inputMode="decimal" className={`${inputClass} w-full`} required />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="地區" error={e.locations} hint="以逗號分隔，例如：台灣">
          <input name="locations" defaultValue={v.locations} className={`${inputClass} w-full`} required />
        </Field>
        <Field label="語言" error={e.languages} hint="以逗號分隔，例如：zh-TW, en">
          <input name="languages" defaultValue={v.languages} className={`${inputClass} w-full`} required />
        </Field>
      </div>
      <Field label="目標受眾（選填）" error={e.audience}>
        <textarea name="audience" defaultValue={v.audience} rows={2} className={`${inputClass} w-full`} />
      </Field>
      <Field label="其他備註（選填）" error={e.notes} hint="品牌語氣、必須包含或避免的詞、促銷資訊">
        <textarea name="notes" defaultValue={v.notes} rows={3} className={`${inputClass} w-full`} />
      </Field>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? '送出中…' : '產生草稿'}
        </Button>
      </div>
    </form>
  );
}
