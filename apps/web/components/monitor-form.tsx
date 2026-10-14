'use client';

import { useActionState, useState } from 'react';
import type { MonitorFormState } from '../app/(console)/settings/monitor/actions';
import { ACTION_LABEL, MONITOR_FIELDS, MONITOR_TYPE_HINT, MONITOR_TYPE_LABEL, type MonitorFormValues } from '../lib/monitor-rules';
import { Alert, Button, Input, LinkButton, Select, Switch } from './ui';

interface Props {
  action: (prev: MonitorFormState, form: FormData) => Promise<MonitorFormState>;
  initial: MonitorFormValues;
  accounts: { id: string; name: string; currency: string }[];
  campaigns: { id: string; accountId: string; name: string }[];
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
  const errorCount = Object.values(e).filter(Boolean).length;
  return (
    <form action={formAction} className="card flex max-w-[860px] flex-col gap-5 border-accent-glow shadow-[var(--shadow-md),var(--ring-accent)]">
      {errorCount ? <Alert tone="danger" title={`有 ${errorCount} 個欄位需要修正`} /> : null}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
        <Select label="規則類型" name="type" value={type} onChange={(ev) => setType(ev.target.value as MonitorFormValues['type'])} hint={MONITOR_TYPE_HINT[type]} error={e.type}>
          {Object.entries(MONITOR_TYPE_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-5">
        {MONITOR_FIELDS[type].map((f) => (
          <Input key={f.name} label={f.label} name={`f_${f.name}`} defaultValue={initial.fields[f.name] ?? ''} inputMode="decimal" error={e[`f_${f.name}`]} hint={f.hint} required={f.name !== 'minSpend'} />
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
        <Select label="帳戶" name="accountId" value={accountId} onChange={(ev) => setAccountId(ev.target.value)} error={e.accountId}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <Select label="Campaign（選填）" name="campaignEntityId" defaultValue={initial.campaignEntityId} error={e.campaignEntityId} hint="留空 = 帳戶內所有啟用中的 campaign">
          <option value="">所有啟用中的 campaign</option>
          {campaigns
            .filter((c) => c.accountId === accountId)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </Select>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-5">
        <Select label="觸發時的動作" name="actionKind" value={actionKind} onChange={(ev) => setActionKind(ev.target.value as MonitorFormValues['actionKind'])}>
          {Object.entries(ACTION_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
        {actionKind !== 'pause' ? <Input label="幅度 %" name="actionPct" defaultValue={initial.actionPct} inputMode="decimal" error={e.actionPct} required /> : null}
        <Input label="冷卻時間（小時）" name="cooldownHours" defaultValue={initial.cooldownHours} inputMode="decimal" error={e.cooldownHours} hint="觸發後這段時間內不再觸發" required />
      </div>
      <p className="text-meta text-muted">觸發後依「自動化」頁中「熔斷」的模式決定：Shadow 只模擬並在 Slack 回報，Live 直接執行並附 Undo，關閉則不產生變更單。</p>
      <Switch label="啟用" name="enabled" defaultChecked={initial.enabled} />
      <div className="card-footer mt-0">
        <Button variant="primary" disabled={pending}>
          {pending ? '儲存中…' : '儲存'}
        </Button>
        <LinkButton variant="secondary" href="/settings/monitor">
          取消
        </LinkButton>
      </div>
    </form>
  );
}
