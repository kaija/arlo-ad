'use client';

import { MONITOR_RULE_TYPES } from '@arlo/core';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import type { MonitorFormState } from '../app/(console)/settings/monitor/actions';
import { ACTION_KINDS, MONITOR_FIELDS, type MonitorFormValues } from '../lib/monitor-rules';
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
  const t = useTranslations('monitor');
  const tc = useTranslations('common');
  return (
    <form action={formAction} className="card flex max-w-[860px] flex-col gap-5 border-accent-glow shadow-[var(--shadow-md),var(--ring-accent)]">
      {errorCount ? <Alert tone="danger" title={tc('fieldErrorsTitle', { count: errorCount })} /> : null}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
        <Select label={t('form.type')} name="type" value={type} onChange={(ev) => setType(ev.target.value as MonitorFormValues['type'])} hint={t(`hint.${type}`)} error={e.type}>
          {MONITOR_RULE_TYPES.map((v) => (
            <option key={v} value={v}>
              {t(`type.${v}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-5">
        {MONITOR_FIELDS[type].map((f) => (
          <Input key={f.name} label={t(`field.${f.label}`)} name={`f_${f.name}`} defaultValue={initial.fields[f.name] ?? ''} inputMode="decimal" error={e[`f_${f.name}`]} hint={f.hint ? t(`field.${f.hint}`) : undefined} required={f.name !== 'minSpend'} />
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
        <Select label={t('form.account')} name="accountId" value={accountId} onChange={(ev) => setAccountId(ev.target.value)} error={e.accountId}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <Select label={t('form.campaign')} name="campaignEntityId" defaultValue={initial.campaignEntityId} error={e.campaignEntityId} hint={t('form.campaignHint')}>
          <option value="">{t('form.allCampaigns')}</option>
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
        <Select label={t('form.action')} name="actionKind" value={actionKind} onChange={(ev) => setActionKind(ev.target.value as MonitorFormValues['actionKind'])}>
          {ACTION_KINDS.map((v) => (
            <option key={v} value={v}>
              {t(`action.${v}`)}
            </option>
          ))}
        </Select>
        {actionKind !== 'pause' ? <Input label={t('form.actionPct')} name="actionPct" defaultValue={initial.actionPct} inputMode="decimal" error={e.actionPct} required /> : null}
        <Input label={t('form.cooldown')} name="cooldownHours" defaultValue={initial.cooldownHours} inputMode="decimal" error={e.cooldownHours} hint={t('form.cooldownHint')} required />
      </div>
      <p className="text-meta text-muted">{t('form.modeNote')}</p>
      <Switch label={t('form.enabled')} name="enabled" defaultChecked={initial.enabled} />
      <div className="card-footer mt-0">
        <Button variant="primary" disabled={pending}>
          {pending ? tc('saving') : tc('save')}
        </Button>
        <LinkButton variant="secondary" href="/settings/monitor">
          {tc('cancel')}
        </LinkButton>
      </div>
    </form>
  );
}
