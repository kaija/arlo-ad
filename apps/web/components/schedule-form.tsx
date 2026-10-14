'use client';

import type { JOB_TEMPLATES } from '@arlo/db';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import type { ScheduleFormState } from '../app/(console)/schedules/actions';
import { ChipSelect } from './client';
import { Alert, Button, Input, LinkButton, Select, Switch, Textarea } from './ui';

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
  templates: (typeof JOB_TEMPLATES)[number][];
  accounts: { id: string; name: string; externalId: string }[];
  channels: { id: string; name: string; private: boolean }[];
  timeZones: string[];
  /** Non-admins see the settings but cannot change them. */
  readOnly?: boolean;
}

export function ScheduleForm({ action, initial: defaults, templates, accounts, channels, timeZones, readOnly }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const e = state.errors ?? {};
  const initial = state.values ?? defaults;
  const knownChannel = channels.some((c) => c.id === initial.channelId);
  const errorCount = Object.values(e).filter(Boolean).length;
  const t = useTranslations('schedule');
  const tc = useTranslations('common');
  return (
    // Keyed by the echoed values so the uncontrolled fields pick them up after a failed submit.
    <form key={JSON.stringify(initial)} action={formAction} className="card flex min-w-0 flex-[999_1_520px] flex-col gap-5">
      {errorCount ? (
        <Alert tone="danger" title={tc('fieldErrorsTitle', { count: errorCount })}>
          {e.form ?? t('form.checkFields')}
        </Alert>
      ) : null}
      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-5">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-5">
          <Input label={t('form.name')} name="name" defaultValue={initial.name} error={e.name} required />
          <Select label={t('form.template')} name="template" defaultValue={initial.template} error={e.template}>
            {templates.map((tpl) => (
              <option key={tpl} value={tpl}>
                {t(`template.${tpl}`)}
              </option>
            ))}
          </Select>
        </div>
        {channels.length ? (
          <Select label={t('form.channel')} name="channelId" defaultValue={knownChannel ? initial.channelId : ''} hint={t('form.channelHint')} error={e.channelId}>
            <option value="">{t('form.chooseChannel')}</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.private ? t('form.private') : '#'}
                {c.name}
              </option>
            ))}
          </Select>
        ) : (
          <Input label={t('form.channelId')} name="channelId" defaultValue={initial.channelId} placeholder="C04ABCD123" hint={t('form.channelIdHint')} error={e.channelId} className="font-mono" />
        )}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-5">
          <Input label={t('form.cron')} name="cron" defaultValue={initial.cron} hint={t('form.cronHint')} error={e.cron} className="font-mono" required />
          <Select label={t('form.tz')} name="tz" defaultValue={initial.tz} error={e.tz}>
            {timeZones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Select>
        </div>
        <div className="field">
          <span className="field-label">{t('form.accounts')}</span>
          <ChipSelect name="accountIds" options={accounts.map((a) => ({ value: a.id, label: a.name }))} initial={initial.accountIds} disabled={readOnly} />
          <p className="field-hint">{t('form.accountsHint')}</p>
        </div>
        <Textarea label={t('form.extra')} name="extraInstructions" defaultValue={initial.extraInstructions} placeholder={t('form.extraPlaceholder')} error={e.extraInstructions} />
        <Switch label={t('form.enabled')} name="enabled" defaultChecked={initial.enabled} disabled={readOnly} />
      </fieldset>
      {readOnly ? null : (
        <div className="card-footer mt-0">
          <Button variant="primary" disabled={pending}>
            {pending ? tc('saving') : tc('save')}
          </Button>
          <LinkButton variant="secondary" href="/schedules">
            {tc('cancel')}
          </LinkButton>
        </div>
      )}
    </form>
  );
}
