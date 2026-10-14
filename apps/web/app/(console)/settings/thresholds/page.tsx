import { authorize, DEFAULT_TIER_THRESHOLDS } from '@arlo/core';
import { listTierThresholds, resolveAccounts } from '@arlo/db';
import { ThresholdForm } from '../../../../components/threshold-form';
import { Alert, Button, PageHeader } from '../../../../components/ui';
import { thresholdsToForm } from '../../../../lib/rules';
import { getDb } from '../../../../lib/server';
import { requireUser } from '../../../../lib/session';
import { clearThresholdsAction, saveThresholdsAction } from './actions';

export const dynamic = 'force-dynamic';

// Tier thresholds (ADR-0007, Requirement 18.4): an org default, overridable per account.
export default async function ThresholdsPage() {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const db = getDb();
  const [rows, accounts] = await Promise.all([listTierThresholds(db), resolveAccounts(db, { allowed: null })]);
  const org = rows.find((r) => r.accountId === null);
  const orgValues = org ? { tier3Pct: org.tier3Pct, tier3AmountMicros: org.tier3AmountMicros, tier1MaxReducePct: org.tier1MaxReducePct } : DEFAULT_TIER_THRESHOLDS;

  return (
    <>
      <PageHeader
        back={{ href: '/settings', label: '設定' }}
        title="Tier 門檻"
        subtitle="決定變更單的風險分級。Tier 1 為保護性變更（降預算、暫停、降目標 CPA），自動執行並附 Undo；Tier 2 需一人審核；Tier 3 需審核 + 二次確認，且不得由提出者本人核准。"
      />
      {isAdmin ? null : <Alert title="唯讀">所有設定只有 Admin 能修改，你目前可以檢視。</Alert>}
      <div className="flex flex-col gap-4">
        <ThresholdForm action={saveThresholdsAction.bind(null, null)} initial={thresholdsToForm(orgValues)} title="全組織預設" meta={org ? '套用到沒有自訂門檻的帳戶' : '目前使用內建值'} disabled={!isAdmin} />
        {accounts.map((a) => {
          const own = rows.find((r) => r.accountId === a.id);
          return (
            <ThresholdForm
              key={a.id}
              action={saveThresholdsAction.bind(null, a.id)}
              initial={thresholdsToForm(own ? { tier3Pct: own.tier3Pct, tier3AmountMicros: own.tier3AmountMicros, tier1MaxReducePct: own.tier1MaxReducePct } : orgValues)}
              title={a.name}
              meta={`${a.externalId} · ${a.currency}${own ? '' : ' · 沿用全組織預設'}`}
              currency={a.currency}
              disabled={!isAdmin}
              extra={
                own && isAdmin ? (
                  <form action={clearThresholdsAction.bind(null, a.id)}>
                    <Button size="sm">改回預設</Button>
                  </form>
                ) : null
              }
            />
          );
        })}
      </div>
    </>
  );
}
