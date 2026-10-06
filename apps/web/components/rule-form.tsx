'use client';

import { useActionState, useState } from 'react';
import type { RuleFormState } from '../app/(console)/settings/rules/actions';
import { RULE_FIELDS, RULE_TYPE_HINT, RULE_TYPE_LABEL, type RuleFormValues, type ScopeKind } from '../lib/rules';
import { Button, inputClass } from './ui';

interface Props {
  action: (prev: RuleFormState, form: FormData) => Promise<RuleFormState>;
  initial: RuleFormValues;
  accounts: { id: string; name: string; currency: string }[];
  campaigns: { id: string; accountId: string; name: string }[];
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

export function RuleForm({ action, initial: defaults, accounts, campaigns }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const initial = state.values ?? defaults;
  return <RuleFormFields key={JSON.stringify(initial)} formAction={formAction} pending={pending} initial={initial} errors={state.errors ?? {}} accounts={accounts} campaigns={campaigns} />;
}

function RuleFormFields({
  formAction,
  pending,
  initial,
  errors: e,
  accounts,
  campaigns,
}: {
  formAction: (form: FormData) => void;
  pending: boolean;
  initial: RuleFormValues;
  errors: Partial<Record<string, string>>;
  accounts: Props['accounts'];
  campaigns: Props['campaigns'];
}) {
  // Type, scope and account drive which inputs show; everything else stays uncontrolled.
  const [type, setType] = useState(initial.type);
  const [scope, setScope] = useState<ScopeKind>(initial.scopeKind);
  const [accountId, setAccountId] = useState(initial.accountId);
  const [metric, setMetric] = useState(initial.fields.metric || 'tcpa');
  const currency = accounts.find((a) => a.id === accountId)?.currency;

  return (
    <form action={formAction} className="grid max-w-2xl gap-4">
      <Field label="規則類型" error={e.type} hint={RULE_TYPE_HINT[type]}>
        <select name="type" value={type} onChange={(ev) => setType(ev.target.value as RuleFormValues['type'])} className={`${inputClass} w-full`}>
          {Object.entries(RULE_TYPE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="範圍" error={e.scopeKind} hint="範圍越窄越優先（campaign > 帳戶 > 全組織）">
          <select name="scopeKind" value={scope} onChange={(ev) => setScope(ev.target.value as ScopeKind)} className={`${inputClass} w-full`}>
            <option value="org">全組織</option>
            <option value="account">帳戶</option>
            <option value="campaign">Campaign</option>
          </select>
        </Field>
        {scope !== 'org' ? (
          <Field label="帳戶" error={e.accountId}>
            <select name="accountId" value={accountId} onChange={(ev) => setAccountId(ev.target.value)} className={`${inputClass} w-full`}>
              <option value="">選擇帳戶…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {scope === 'campaign' ? (
          <Field label="Campaign" error={e.campaignEntityId}>
            <select name="campaignEntityId" defaultValue={initial.campaignEntityId} className={`${inputClass} w-full`}>
              <option value="">選擇 campaign…</option>
              {campaigns
                .filter((c) => c.accountId === accountId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </Field>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {RULE_FIELDS[type].map((f) =>
          f.kind === 'metric' ? (
            <Field key={f.name} label={f.label} error={e[`f_${f.name}`]}>
              <select name={`f_${f.name}`} value={metric} onChange={(ev) => setMetric(ev.target.value)} className={`${inputClass} w-full`}>
                <option value="tcpa">目標 CPA</option>
                <option value="troas">目標 ROAS</option>
              </select>
            </Field>
          ) : (
            <Field
              key={f.name}
              label={f.label}
              error={e[`f_${f.name}`]}
              hint={f.kind === 'money' ? (type === 'BidTargetRange' && metric === 'troas' ? '百分比，例如 400 = 400%' : currency ? `${currency}` : '以各帳戶幣別計') : undefined}
            >
              <input name={`f_${f.name}`} defaultValue={initial.fields[f.name] ?? ''} inputMode="decimal" className={`${inputClass} w-full`} required />
            </Field>
          ),
        )}
      </div>

      <div className="flex flex-wrap items-center gap-6">
        <Field label="嚴重度">
          <select name="severity" defaultValue={initial.severity} className={inputClass}>
            <option value="HARD_BLOCK">阻擋（HARD_BLOCK）</option>
            <option value="WARN">警告（升為需審核）</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 pt-5 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={initial.enabled} />
          啟用
        </label>
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? '儲存中…' : '儲存'}
        </Button>
      </div>
    </form>
  );
}
