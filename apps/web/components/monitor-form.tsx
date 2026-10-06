'use client';

import { useActionState, useState } from 'react';
import type { MonitorFormState } from '../app/(console)/settings/monitor/actions';
import { ACTION_LABEL, MONITOR_FIELDS, MONITOR_TYPE_HINT, MONITOR_TYPE_LABEL, type MonitorFormValues } from '../lib/monitor-rules';
import { Button, inputClass } from './ui';

interface Props {
  action: (prev: MonitorFormState, form: FormData) => Promise<MonitorFormState>;
  initial: MonitorFormValues;
  accounts: { id: string; name: string; currency: string }[];
  campaigns: { id: string; accountId: string; name: string }[];
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error ? <span className="block text-xs text-red-600">{error}</span> : hint ? <span className="block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

export function MonitorForm({ action, initial: defaults, accounts, campaigns }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const initial = state.values ?? defaults;
  return <Fields key={JSON.stringify(initial)} formAction={formAction} pending={pending} initial={initial} errors={state.errors ?? {}} accounts={accounts} campaigns={campaigns} />;
}

function Fields({ formAction, pending, initial, errors: e, accounts, campaigns }: { formAction: (f: FormData) => void; pending: boolean; initial: MonitorFormValues; errors: Partial<Record<string, string>>; accounts: Props['accounts']; campaigns: Props['campaigns'] }) {
  const [type, setType] = useState(initial.type);
  const [accountId, setAccountId] = useState(initial.accountId || accounts[0]?.id || '');
  const [actionKind, setActionKind] = useState(initial.actionKind);
  return (
    <form action={formAction} className="grid max-w-2xl gap-4">
      <Field label="規則類型" error={e.type} hint={MONITOR_TYPE_HINT[type]}>
        <select name="type" value={type} onChange={(ev) => setType(ev.target.value as MonitorFormValues['type'])} className={`${inputClass} w-full`}>
          {Object.entries(MONITOR_TYPE_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="帳戶" error={e.accountId}>
          <select name="accountId" value={accountId} onChange={(ev) => setAccountId(ev.target.value)} className={`${inputClass} w-full`}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Campaign" error={e.campaignEntityId} hint="留空 = 帳戶內所有啟用中的 campaign">
          <select name="campaignEntityId" defaultValue={initial.campaignEntityId} className={`${inputClass} w-full`}>
            <option value="">所有啟用中的 campaign</option>
            {campaigns
              .filter((c) => c.accountId === accountId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {MONITOR_FIELDS[type].map((f) => (
          <Field key={f.name} label={f.label} error={e[`f_${f.name}`]} hint={f.hint}>
            <input name={`f_${f.name}`} defaultValue={initial.fields[f.name] ?? ''} inputMode="decimal" className={`${inputClass} w-full`} required={f.name !== 'minSpend'} />
          </Field>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="觸發時的動作">
          <select name="actionKind" value={actionKind} onChange={(ev) => setActionKind(ev.target.value as MonitorFormValues['actionKind'])} className={`${inputClass} w-full`}>
            {Object.entries(ACTION_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {actionKind !== 'pause' ? (
          <Field label="幅度（%）" error={e.actionPct}>
            <input name="actionPct" defaultValue={initial.actionPct} inputMode="decimal" className={`${inputClass} w-full`} required />
          </Field>
        ) : null}
        <Field label="冷卻（小時）" error={e.cooldownHours} hint="同一 campaign 觸發後多久內不再觸發">
          <input name="cooldownHours" defaultValue={initial.cooldownHours} inputMode="decimal" className={`${inputClass} w-full`} required />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="enabled" defaultChecked={initial.enabled} /> 啟用
      </label>
      <p className="text-xs text-zinc-500">觸發後產生 Tier 1 變更，依「自動化」頁的模式執行：Shadow 只模擬、Live 直接執行並附 Undo、關閉則不產生。</p>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? '儲存中…' : '儲存'}
        </Button>
      </div>
    </form>
  );
}
