'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button, Checkbox, Radio, Select } from './ui';

/** New role binding: role, approvable tier (approver / admin only) and account scope. */
export function GrantForm({ action, roles, accounts }: { action: (form: FormData) => Promise<void>; roles: { value: string; label: string }[]; accounts: { id: string; name: string }[] }) {
  const [role, setRole] = useState('viewer');
  const [all, setAll] = useState(true);
  const canApprove = role === 'approver' || role === 'admin';
  const t = useTranslations('users.grant');
  return (
    <form action={action} className="flex flex-col gap-4 border-t border-border pt-5">
      <span className="text-ui font-semibold">{t('title')}</span>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <Select label={t('role')} name="role" value={role} onChange={(e) => setRole(e.target.value)}>
          {roles.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
        <Select label={t('maxTier')} name="maxTier" defaultValue="2" disabled={!canApprove} hint={canApprove ? t('tier3Hint') : t('approversOnly')}>
          <option value="1">Tier 1</option>
          <option value="2">Tier 2</option>
          <option value="3">Tier 3</option>
        </Select>
      </div>
      <div className="field">
        <span className="field-label">{t('scope')}</span>
        <div className="flex flex-col gap-2.5">
          <Radio name="scope" label={t('allAccounts')} checked={all} onChange={() => setAll(true)} />
          <Radio name="scope" label={t('someAccounts')} checked={!all} onChange={() => setAll(false)} />
          {all ? (
            <input type="hidden" name="allAccounts" value="on" />
          ) : (
            <div className="flex flex-wrap gap-5 pl-7">
              {accounts.map((a) => (
                <Checkbox key={a.id} name="accountIds" value={a.id} label={a.name} />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex">
        <Button variant="primary">{t('submit')}</Button>
      </div>
    </form>
  );
}
