'use client';

import { RULE_TYPES } from '@arlo/core';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import type { RuleFormState } from '../app/(console)/settings/rules/actions';
import { RULE_FIELDS, type RuleFormValues, type ScopeKind } from '../lib/rules';
import { Alert, Button, Input, LinkButton, Radio, Select, Switch } from './ui';

interface Props {
  action: (prev: RuleFormState, form: FormData) => Promise<RuleFormState>;
  initial: RuleFormValues;
  accounts: { id: string; name: string; currency: string }[];
  campaigns: { id: string; accountId: string; name: string }[];
}

const SCOPES: readonly ScopeKind[] = ['org', 'account', 'campaign'];

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
  const t = useTranslations('rules');
  const tc = useTranslations('common');

  return (
    <form action={formAction} className="card flex max-w-[860px] flex-col gap-5 border-accent-glow shadow-[var(--shadow-md),var(--ring-accent)]">
      {errorCount ? <Alert tone="danger" title={tc('fieldErrorsTitle', { count: errorCount })} /> : null}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
        <Select label={t('form.type')} name="type" value={type} onChange={(ev) => setType(ev.target.value as RuleFormValues['type'])} hint={t(`hint.${type}`)} error={e.type}>
          {RULE_TYPES.map((value) => (
            <option key={value} value={value}>
              {t(`type.${value}`)}
            </option>
          ))}
        </Select>
      </div>

      {type === 'BidTargetRange' ? (
        <div className="field">
          <span className="field-label">{t('form.bidTarget')}</span>
          <div className="flex flex-wrap gap-6">
            <Radio name="f_metric" value="tcpa" label={t('form.tcpa')} checked={metric === 'tcpa'} onChange={() => setMetric('tcpa')} />
            <Radio name="f_metric" value="troas" label={t('form.troas')} checked={metric === 'troas'} onChange={() => setMetric('troas')} />
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-5">
        {RULE_FIELDS[type]
          .filter((f) => f.kind !== 'metric')
          .map((f) => (
            <Input
              key={f.name}
              label={t(`field.${f.label}`)}
              name={`f_${f.name}`}
              defaultValue={initial.fields[f.name] ?? ''}
              inputMode="decimal"
              error={e[`f_${f.name}`]}
              hint={f.kind === 'money' ? (type === 'BidTargetRange' && metric === 'troas' ? t('form.percentHint') : (currency ?? t('form.perAccountCurrency'))) : undefined}
              required
            />
          ))}
      </div>

      <div className="field">
        <span className="field-label">{t('form.scope')}</span>
        <div className="flex flex-wrap gap-6">
          {SCOPES.map((value) => (
            <Radio key={value} name="scopeKind" value={value} label={t(`scope.${value}`)} checked={scope === value} onChange={() => setScope(value)} />
          ))}
        </div>
        <p className={`field-hint ${e.scopeKind ? 'field-hint-error' : ''}`}>{e.scopeKind ?? t('form.scopeHint')}</p>
      </div>
      {scope !== 'org' ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
          <Select label={t('form.account')} name="accountId" value={accountId} onChange={(ev) => setAccountId(ev.target.value)} error={e.accountId}>
            <option value="">{t('form.chooseAccount')}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          {scope === 'campaign' ? (
            <Select label={t('scope.campaign')} name="campaignEntityId" defaultValue={initial.campaignEntityId} error={e.campaignEntityId}>
              <option value="">{t('form.chooseCampaign')}</option>
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
        <span className="field-label">{t('form.severity')}</span>
        <div className="flex flex-wrap gap-6">
          <Radio name="severity" value="HARD_BLOCK" label={t('form.hardBlock')} defaultChecked={initial.severity === 'HARD_BLOCK'} />
          <Radio name="severity" value="WARN" label={t('form.warnOption')} defaultChecked={initial.severity === 'WARN'} />
        </div>
      </div>
      <Switch label={t('form.enabled')} name="enabled" defaultChecked={initial.enabled} />
      <div className="card-footer mt-0">
        <Button variant="primary" disabled={pending}>
          {pending ? tc('saving') : tc('save')}
        </Button>
        <LinkButton variant="secondary" href="/settings/rules">
          {tc('cancel')}
        </LinkButton>
      </div>
    </form>
  );
}
