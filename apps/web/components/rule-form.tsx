'use client';

import { useActionState, useState } from 'react';
import type { RuleFormState } from '../app/(console)/settings/rules/actions';
import { RULE_FIELDS, RULE_TYPE_HINT, RULE_TYPE_LABEL, type RuleFormValues, type ScopeKind } from '../lib/rules';
import { Alert, Button, Input, LinkButton, Radio, Select, Switch } from './ui';

interface Props {
  action: (prev: RuleFormState, form: FormData) => Promise<RuleFormState>;
  initial: RuleFormValues;
  accounts: { id: string; name: string; currency: string }[];
  campaigns: { id: string; accountId: string; name: string }[];
}

const SCOPES: [ScopeKind, string][] = [
  ['org', '全組織'],
  ['account', '帳戶'],
  ['campaign', 'Campaign'],
];

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
  const errorCount = Object.values(e).filter(Boolean).length;

  return (
    <form action={formAction} className="card flex max-w-[860px] flex-col gap-5 border-accent-glow shadow-[var(--shadow-md),var(--ring-accent)]">
      {errorCount ? <Alert tone="danger" title={`有 ${errorCount} 個欄位需要修正`} /> : null}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
        <Select label="規則類型" name="type" value={type} onChange={(ev) => setType(ev.target.value as RuleFormValues['type'])} hint={RULE_TYPE_HINT[type]} error={e.type}>
          {Object.entries(RULE_TYPE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>

      {type === 'BidTargetRange' ? (
        <div className="field">
          <span className="field-label">出價目標</span>
          <div className="flex flex-wrap gap-6">
            <Radio name="f_metric" value="tcpa" label="目標 CPA（金額）" checked={metric === 'tcpa'} onChange={() => setMetric('tcpa')} />
            <Radio name="f_metric" value="troas" label="目標 ROAS（%）" checked={metric === 'troas'} onChange={() => setMetric('troas')} />
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-5">
        {RULE_FIELDS[type]
          .filter((f) => f.kind !== 'metric')
          .map((f) => (
            <Input
              key={f.name}
              label={f.label}
              name={`f_${f.name}`}
              defaultValue={initial.fields[f.name] ?? ''}
              inputMode="decimal"
              error={e[`f_${f.name}`]}
              hint={f.kind === 'money' ? (type === 'BidTargetRange' && metric === 'troas' ? '百分比，例如 400 = 400%' : (currency ?? '以各帳戶幣別計')) : undefined}
              required
            />
          ))}
      </div>

      <div className="field">
        <span className="field-label">範圍</span>
        <div className="flex flex-wrap gap-6">
          {SCOPES.map(([value, label]) => (
            <Radio key={value} name="scopeKind" value={value} label={label} checked={scope === value} onChange={() => setScope(value)} />
          ))}
        </div>
        <p className={`field-hint ${e.scopeKind ? 'field-hint-error' : ''}`}>{e.scopeKind ?? '範圍越窄越優先：Campaign 規則覆蓋帳戶規則，帳戶規則覆蓋全組織規則。'}</p>
      </div>
      {scope !== 'org' ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
          <Select label="帳戶" name="accountId" value={accountId} onChange={(ev) => setAccountId(ev.target.value)} error={e.accountId}>
            <option value="">選擇帳戶…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          {scope === 'campaign' ? (
            <Select label="Campaign" name="campaignEntityId" defaultValue={initial.campaignEntityId} error={e.campaignEntityId}>
              <option value="">選擇 campaign…</option>
              {campaigns
                .filter((c) => c.accountId === accountId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          ) : null}
        </div>
      ) : null}

      <div className="field">
        <span className="field-label">嚴重度</span>
        <div className="flex flex-wrap gap-6">
          <Radio name="severity" value="HARD_BLOCK" label="阻擋 — 任何人都不能核准" defaultChecked={initial.severity === 'HARD_BLOCK'} />
          <Radio name="severity" value="WARN" label="警告 — 升為需審核" defaultChecked={initial.severity === 'WARN'} />
        </div>
      </div>
      <Switch label="啟用" name="enabled" defaultChecked={initial.enabled} />
      <div className="card-footer mt-0">
        <Button variant="primary" disabled={pending}>
          {pending ? '儲存中…' : '儲存'}
        </Button>
        <LinkButton variant="secondary" href="/settings/rules">
          取消
        </LinkButton>
      </div>
    </form>
  );
}
