'use client';

import { useActionState } from 'react';
import type { ScheduleFormState } from '../app/(console)/schedules/actions';
import { Button, inputClass } from './ui';

export interface ScheduleFormValues {
  name: string;
  template: string;
  cron: string;
  tz: string;
  accountIds: string[];
  channelId: string;
  extraInstructions: string;
  enabled: boolean;
}

interface Props {
  action: (prev: ScheduleFormState, form: FormData) => Promise<ScheduleFormState>;
  initial: ScheduleFormValues;
  templates: { value: string; label: string }[];
  accounts: { id: string; name: string; externalId: string }[];
  channels: { id: string; name: string; private: boolean }[];
  timeZones: string[];
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && !error ? <span className="block text-xs text-zinc-500">{hint}</span> : null}
      {error ? <span className="block text-xs text-red-600">{error}</span> : null}
    </label>
  );
}

export function ScheduleForm({ action, initial: defaults, templates, accounts, channels, timeZones }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const e = state.errors ?? {};
  const initial = state.values ?? defaults;
  const knownChannel = channels.some((c) => c.id === initial.channelId);
  return (
    // Keyed by the echoed values so the uncontrolled fields pick them up after a failed submit.
    <form key={JSON.stringify(initial)} action={formAction} className="grid max-w-2xl gap-4">
      <Field label="名稱" error={e.name}>
        <input name="name" defaultValue={initial.name} className={`${inputClass} w-full`} required />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="模板" error={e.template}>
          <select name="template" defaultValue={initial.template} className={`${inputClass} w-full`}>
            {templates.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="目標 Slack channel" error={e.channelId} hint={channels.length ? '僅列出 bot 已加入的 channel' : '無法讀取 channel 清單，請輸入 channel ID'}>
          {channels.length ? (
            <select name="channelId" defaultValue={knownChannel ? initial.channelId : ''} className={`${inputClass} w-full`}>
              <option value="">選擇 channel…</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.private ? '🔒' : '#'}
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <input name="channelId" defaultValue={initial.channelId} placeholder="C0123456789" className={`${inputClass} w-full`} />
          )}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Cron" error={e.cron} hint="分 時 日 月 星期，例如 0 9 * * 1-5（平日 09:00）">
          <input name="cron" defaultValue={initial.cron} className={`${inputClass} w-full font-mono`} required />
        </Field>
        <Field label="時區" error={e.tz}>
          <select name="tz" defaultValue={initial.tz} className={`${inputClass} w-full`}>
            {timeZones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">帳戶</legend>
        <p className="text-xs text-zinc-500">都不勾選 = 所有啟用中的帳戶</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {accounts.map((a) => (
            <label key={a.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="accountIds" value={a.id} defaultChecked={initial.accountIds.includes(a.id)} />
              {a.name}
              <span className="text-xs text-zinc-500">{a.externalId}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="額外指示（選填）" error={e.extraInstructions} hint="會交給 agent 參考，例如「特別注意 Brand campaign 的 CPA」">
        <textarea name="extraInstructions" defaultValue={initial.extraInstructions} rows={3} className={`${inputClass} w-full`} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="enabled" defaultChecked={initial.enabled} />
        啟用
      </label>
      {e.form ? <p className="text-sm text-red-600">{e.form}</p> : null}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? '儲存中…' : '儲存'}
        </Button>
      </div>
    </form>
  );
}
