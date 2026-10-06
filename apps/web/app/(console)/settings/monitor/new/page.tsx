import { authorize } from '@arlo/core';
import { redirect } from 'next/navigation';
import { MonitorForm } from '../../../../../components/monitor-form';
import { Card, PageTitle } from '../../../../../components/ui';
import { getDb } from '../../../../../lib/server';
import { requireUser } from '../../../../../lib/session';
import { ruleFormOptions } from '../../../../../lib/settings-page-data';
import { saveMonitorAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NewMonitorRulePage() {
  const user = await requireUser();
  if (!authorize(user, 'admin').allowed) redirect('/settings/monitor');
  return (
    <>
      <PageTitle>新增 Monitor 規則</PageTitle>
      <Card>
        <MonitorForm
          action={saveMonitorAction.bind(null, null)}
          initial={{ type: 'SpendPacing', accountId: '', campaignEntityId: '', fields: { pct: '150', minSpend: '0' }, actionKind: 'pause', actionPct: '', cooldownHours: '6', enabled: true }}
          {...await ruleFormOptions(getDb())}
        />
      </Card>
    </>
  );
}
