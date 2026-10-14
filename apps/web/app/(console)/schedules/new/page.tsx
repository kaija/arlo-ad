import { authorize } from '@arlo/core';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { ScheduleForm } from '../../../../components/schedule-form';
import { PageHeader } from '../../../../components/ui';
import { scheduleFormOptions } from '../../../../lib/schedule-page-data';
import { getDb } from '../../../../lib/server';
import { requireUser } from '../../../../lib/session';
import { saveScheduleAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NewSchedulePage() {
  const user = await requireUser();
  if (!authorize(user, 'admin').allowed) redirect('/schedules');
  const options = await scheduleFormOptions(getDb());
  const t = await getTranslations('schedule');
  return (
    <>
      <PageHeader back={{ href: '/schedules', label: t('title') }} title={t('new')} />
      <div className="flex max-w-[860px]">
        <ScheduleForm
          action={saveScheduleAction.bind(null, null)}
          initial={{ name: t('template.daily_report'), template: 'daily_report', cron: '0 9 * * *', tz: 'Asia/Taipei', accountIds: [], channelId: '', extraInstructions: '', enabled: true }}
          {...options}
        />
      </div>
    </>
  );
}
