'use client';

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
  templates: { value: string; label: string }[];
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
  return (
    // Keyed by the echoed values so the uncontrolled fields pick them up after a failed submit.
    <form key={JSON.stringify(initial)} action={formAction} className="card flex min-w-0 flex-[999_1_520px] flex-col gap-5">
      {errorCount ? (
        <Alert tone="danger" title={`有 ${errorCount} 個欄位需要修正`}>
          {e.form ?? '請檢查標示的欄位。'}
        </Alert>
      ) : null}
      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-5">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-5">
          <Input label="名稱" name="name" defaultValue={initial.name} error={e.name} required />
          <Select label="模板" name="template" defaultValue={initial.template} error={e.template}>
            {templates.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>
        {channels.length ? (
          <Select label="目標 Slack channel" name="channelId" defaultValue={knownChannel ? initial.channelId : ''} hint="只列出 bot 已加入的 channel" error={e.channelId}>
            <option value="">選擇 channel…</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.private ? '（私人）' : '#'}
                {c.name}
              </option>
            ))}
          </Select>
        ) : (
          <Input label="目標 Slack channel ID" name="channelId" defaultValue={initial.channelId} placeholder="C04ABCD123" hint="讀不到 bot 已加入的 channel 清單，請手動輸入 channel ID。" error={e.channelId} className="font-mono" />
        )}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-5">
          <Input label="cron 運算式" name="cron" defaultValue={initial.cron} hint="分 時 日 月 週，例如 0 9 * * 1-5" error={e.cron} className="font-mono" required />
          <Select label="時區" name="tz" defaultValue={initial.tz} error={e.tz}>
            {timeZones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Select>
        </div>
        <div className="field">
          <span className="field-label">帳戶</span>
          <ChipSelect name="accountIds" options={accounts.map((a) => ({ value: a.id, label: a.name }))} initial={initial.accountIds} disabled={readOnly} />
          <p className="field-hint">都不選 = 所有啟用中的帳戶</p>
        </div>
        <Textarea label="給 agent 的額外指示（選填）" name="extraInstructions" defaultValue={initial.extraInstructions} placeholder="例如：報告只列出 CPA 變動超過 20% 的 campaign" error={e.extraInstructions} />
        <Switch label="啟用" name="enabled" defaultChecked={initial.enabled} disabled={readOnly} />
      </fieldset>
      {readOnly ? null : (
        <div className="card-footer mt-0">
          <Button variant="primary" disabled={pending}>
            {pending ? '儲存中…' : '儲存'}
          </Button>
          <LinkButton variant="secondary" href="/schedules">
            取消
          </LinkButton>
        </div>
      )}
    </form>
  );
}
