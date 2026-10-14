'use client';

import { useActionState, useState } from 'react';
import type { BriefFormState } from '../app/(console)/campaigns/actions';
import type { BriefFormValues } from '../lib/campaigns';
import { Alert, Button, Input, LinkButton, Select, Textarea } from './ui';

export function BriefForm({ action, initial: defaults, accounts }: { action: (prev: BriefFormState, form: FormData) => Promise<BriefFormState>; initial: BriefFormValues; accounts: { id: string; name: string; currency: string }[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const e = state.errors ?? {};
  const v = state.values ?? defaults;
  const [accountId, setAccountId] = useState(v.accountId);
  const currency = accounts.find((a) => a.id === accountId)?.currency ?? '帳戶幣別';
  const errorCount = Object.values(e).filter(Boolean).length;
  return (
    // Keyed by the echoed values so the uncontrolled fields pick them up after a failed submit.
    <form key={JSON.stringify(v)} action={formAction} className="flex flex-col gap-6">
      {errorCount ? (
        <Alert tone="danger" title={`有 ${errorCount} 個欄位需要修正`}>
          請檢查下方標示的欄位後再送出。
        </Alert>
      ) : null}
      <div className="card flex flex-col gap-5">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
          <Select label="帳戶" name="accountId" value={accountId} onChange={(ev) => setAccountId(ev.target.value)} error={e.accountId}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Input label="Campaign 名稱" name="name" defaultValue={v.name} placeholder="例如 Arlo 企業方案｜Search" error={e.name} required />
        </div>
        <Textarea label="目標" name="objective" defaultValue={v.objective} rows={2} placeholder="例如：取得企業試用申請、提高線上銷售" error={e.objective} required />
        <Textarea label="產品 / 服務與賣點" name="offering" defaultValue={v.offering} rows={4} placeholder="販售什麼、和競品差在哪、價格或優惠" error={e.offering} required />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
          <Input label="到達網頁" name="landingPageUrl" defaultValue={v.landingPageUrl} placeholder="https://" error={e.landingPageUrl} required />
          <Input label={`每日預算（${currency}）`} name="dailyBudget" defaultValue={v.dailyBudget} inputMode="decimal" placeholder="3000" error={e.dailyBudget} required />
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
          <Input label="地區（可多個）" name="locations" defaultValue={v.locations} hint="以逗號分隔，例如：台灣, 香港" error={e.locations} required />
          <Input label="語言（可多個）" name="languages" defaultValue={v.languages} hint="以逗號分隔，例如：zh-TW, en" error={e.languages} required />
        </div>
        <Input label="目標受眾（選填）" name="audience" defaultValue={v.audience} placeholder="例如 50 人以上企業的 IT 主管" error={e.audience} />
        <Textarea label="其他備註（選填）" name="notes" defaultValue={v.notes} rows={3} placeholder="不想出現的字、必須包含的訊息等" error={e.notes} />
        <div className="card-footer mt-1">
          <Button variant="primary" disabled={pending}>
            {pending ? '送出中…' : '送出並產生草稿'}
          </Button>
          <LinkButton variant="secondary" href="/campaigns">
            取消
          </LinkButton>
        </div>
      </div>
    </form>
  );
}
