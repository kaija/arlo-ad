'use client';

import { useActionState } from 'react';
import type { ProfileFormState } from '../app/(console)/settings/business-profile/actions';
import { COMPETITOR_POLICY_LABEL, type ProfileFormValues } from '../lib/business-profile';
import { Button, inputClass } from './ui';

const AREAS: { name: keyof ProfileFormValues; label: string; hint: string; rows: number }[] = [
  { name: 'offerings', label: '販售內容', hint: '每行一項，例如「家用監視器」「Video Doorbell」', rows: 4 },
  { name: 'targetIntents', label: '想要的搜尋意圖', hint: '每行一項，例如「購買」「型號比較」「價格」', rows: 4 },
  { name: 'excludedIntents', label: '要排除的搜尋意圖', hint: '每行一項，例如「免費」「求職」「二手」「維修教學」', rows: 4 },
  { name: 'brandTerms', label: '品牌字', hint: '含這些字的搜尋字詞永遠不會被自動排除', rows: 3 },
];

export function ProfileForm({ action, initial: defaults, disabled }: { action: (prev: ProfileFormState, form: FormData) => Promise<ProfileFormState>; initial: ProfileFormValues; disabled: boolean }) {
  const [state, formAction, pending] = useActionState(action, {});
  const e = state.errors ?? {};
  const initial = state.values ?? defaults;
  return (
    <form key={JSON.stringify(initial)} action={formAction} className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        {AREAS.map((a) => (
          <label key={a.name} className="block space-y-1">
            <span className="text-sm font-medium">{a.label}</span>
            <textarea name={a.name} defaultValue={initial[a.name]} rows={a.rows} className={`${inputClass} w-full`} disabled={disabled} />
            {e[a.name] ? <span className="block text-xs text-red-600">{e[a.name]}</span> : <span className="block text-xs text-zinc-500">{a.hint}</span>}
          </label>
        ))}
      </div>
      <label className="block max-w-sm space-y-1">
        <span className="text-sm font-medium">競品字詞</span>
        <select name="competitorPolicy" defaultValue={initial.competitorPolicy} className={`${inputClass} w-full`} disabled={disabled}>
          {Object.entries(COMPETITOR_POLICY_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {e.competitorPolicy ? <span className="block text-xs text-red-600">{e.competitorPolicy}</span> : null}
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">範例字詞</span>
        <textarea name="examples" defaultValue={initial.examples} rows={8} className={`${inputClass} w-full font-mono`} disabled={disabled} />
        {e.examples ? (
          <span className="block text-xs text-red-600">{e.examples}</span>
        ) : (
          <span className="block text-xs text-zinc-500">每行「字詞 | 相關 或 不相關 | 備註」。審核時剔除的否定字詞也會自動加到這裡。</span>
        )}
      </label>
      {disabled ? null : (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? '儲存中…' : '儲存新版本'}
          </Button>
          {state.savedVersion ? <span className="text-sm text-emerald-600">已儲存為第 {state.savedVersion} 版</span> : null}
        </div>
      )}
    </form>
  );
}
