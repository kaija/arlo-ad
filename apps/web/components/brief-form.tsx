'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import type { BriefFormState } from '../app/(console)/campaigns/actions';
import type { BriefFormValues } from '../lib/campaigns';
import { Alert, Button, Input, LinkButton, Select, Textarea } from './ui';

export function BriefForm({ action, initial: defaults, accounts }: { action: (prev: BriefFormState, form: FormData) => Promise<BriefFormState>; initial: BriefFormValues; accounts: { id: string; name: string; currency: string }[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const e = state.errors ?? {};
  const v = state.values ?? defaults;
  const [accountId, setAccountId] = useState(v.accountId);
  const t = useTranslations('brief');
  const tc = useTranslations('common');
  const currency = accounts.find((a) => a.id === accountId)?.currency ?? tc('accountCurrency');
  const errorCount = Object.values(e).filter(Boolean).length;
  return (
    // Keyed by the echoed values so the uncontrolled fields pick them up after a failed submit.
    <form key={JSON.stringify(v)} action={formAction} className="flex flex-col gap-6">
      {errorCount ? (
        <Alert tone="danger" title={tc('fieldErrorsTitle', { count: errorCount })}>
          {tc('fieldErrorsBody')}
        </Alert>
      ) : null}
      <div className="card flex flex-col gap-5">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
          <Select label={tc('account')} name="accountId" value={accountId} onChange={(ev) => setAccountId(ev.target.value)} error={e.accountId}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Input label={t('name')} name="name" defaultValue={v.name} placeholder={t('namePlaceholder')} error={e.name} required />
        </div>
        <Textarea label={t('objective')} name="objective" defaultValue={v.objective} rows={2} placeholder={t('objectivePlaceholder')} error={e.objective} required />
        <Textarea label={t('offering')} name="offering" defaultValue={v.offering} rows={4} placeholder={t('offeringPlaceholder')} error={e.offering} required />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
          <Input label={t('landingPage')} name="landingPageUrl" defaultValue={v.landingPageUrl} placeholder="https://" error={e.landingPageUrl} required />
          <Input label={t('dailyBudget', { currency })} name="dailyBudget" defaultValue={v.dailyBudget} inputMode="decimal" placeholder="3000" error={e.dailyBudget} required />
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
          <Input label={t('locations')} name="locations" defaultValue={v.locations} hint={t('locationsHint')} error={e.locations} required />
          <Input label={t('languages')} name="languages" defaultValue={v.languages} hint={t('languagesHint')} error={e.languages} required />
        </div>
        <Input label={t('audience')} name="audience" defaultValue={v.audience} placeholder={t('audiencePlaceholder')} error={e.audience} />
        <Textarea label={t('notes')} name="notes" defaultValue={v.notes} rows={3} placeholder={t('notesPlaceholder')} error={e.notes} />
        <div className="card-footer mt-1">
          <Button variant="primary" disabled={pending}>
            {pending ? tc('submitting') : t('submit')}
          </Button>
          <LinkButton variant="secondary" href="/campaigns">
            {tc('cancel')}
          </LinkButton>
        </div>
      </div>
    </form>
  );
}
