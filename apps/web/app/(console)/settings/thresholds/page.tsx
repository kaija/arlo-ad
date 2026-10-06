import { authorize, DEFAULT_TIER_THRESHOLDS } from '@arlo/core';
import { listTierThresholds, resolveAccounts } from '@arlo/db';
import { ThresholdForm } from '../../../../components/threshold-form';
import { Button, Card, PageTitle } from '../../../../components/ui';
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
      <PageTitle>Tier 門檻</PageTitle>
      <p className="mb-4 max-w-3xl text-sm text-zinc-500">
        保護性變更（降低預算、暫停、降低目標 CPA、EXACT 否定關鍵字）在自動執行降幅內為 Tier 1，會直接執行並附 Undo；擴張性變更至少 Tier 2，需要 approver 核准；超過 Tier 3 門檻的變更需要確認且不得由提出者本人核准。
      </p>
      <Card title={`全組織預設${org ? '' : '（目前使用內建值）'}`}>
        <ThresholdForm action={saveThresholdsAction.bind(null, null)} initial={thresholdsToForm(orgValues)} disabled={!isAdmin} />
      </Card>
      {accounts.map((a) => {
        const own = rows.find((r) => r.accountId === a.id);
        return (
          <Card
            key={a.id}
            className="mt-4"
            title={`${a.name}${own ? '' : '（沿用全組織預設）'}`}
            actions={
              own && isAdmin ? (
                <form action={clearThresholdsAction.bind(null, a.id)}>
                  <Button variant="secondary">改回預設</Button>
                </form>
              ) : null
            }
          >
            <ThresholdForm
              action={saveThresholdsAction.bind(null, a.id)}
              initial={thresholdsToForm(own ? { tier3Pct: own.tier3Pct, tier3AmountMicros: own.tier3AmountMicros, tier1MaxReducePct: own.tier1MaxReducePct } : orgValues)}
              currency={a.currency}
              disabled={!isAdmin}
            />
          </Card>
        );
      })}
    </>
  );
}
