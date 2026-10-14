import { authorize } from '@arlo/core';
import { redirect } from 'next/navigation';
import { MonitorForm } from '../../../../../components/monitor-form';
import { PageHeader } from '../../../../../components/ui';
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
      <PageHeader back={{ href: '/settings/monitor', label: 'Monitor 熔斷規則' }} title="新增規則" />
      <MonitorForm
        action={saveMonitorAction.bind(null, null)}
        initial={{ type: 'SpendPacing', accountId: '', campaignEntityId: '', fields: { pct: '150', minSpend: '0' }, actionKind: 'pause', actionPct: '', cooldownHours: '6', enabled: true }}
        {...await ruleFormOptions(getDb())}
      />
    </>
  );
}
