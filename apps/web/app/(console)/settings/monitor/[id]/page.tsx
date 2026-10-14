import { authorize } from '@arlo/core';
import { getMonitorRule } from '@arlo/db';
import { getTranslations } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import { MonitorForm } from '../../../../../components/monitor-form';
import { PageHeader } from '../../../../../components/ui';
import { monitorToForm } from '../../../../../lib/monitor-rules';
import { getDb } from '../../../../../lib/server';
import { requireUser } from '../../../../../lib/session';
import { ruleFormOptions } from '../../../../../lib/settings-page-data';
import { saveMonitorAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function EditMonitorRulePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!authorize(user, 'admin').allowed) redirect('/settings/monitor');
  const { id } = await params;
  const db = getDb();
  const rule = /^[0-9a-f-]{36}$/i.test(id) ? await getMonitorRule(db, id) : undefined;
  if (!rule) notFound();
  const t = await getTranslations('monitor');
  return (
    <>
      <PageHeader back={{ href: '/settings/monitor', label: t('title') }} title={t('edit')} />
      <MonitorForm action={saveMonitorAction.bind(null, rule.id)} initial={monitorToForm(rule)} {...await ruleFormOptions(db)} />
    </>
  );
}
