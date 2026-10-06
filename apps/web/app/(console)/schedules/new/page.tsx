import { redirect } from 'next/navigation';
import { authorize } from '@arlo/core';
import { ScheduleForm } from '../../../../components/schedule-form';
import { Card, PageTitle } from '../../../../components/ui';
import { scheduleFormOptions } from '../../../../lib/schedule-page-data';
import { getDb } from '../../../../lib/server';
import { requireUser } from '../../../../lib/session';
import { saveScheduleAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NewSchedulePage() {
  const user = await requireUser();
  if (!authorize(user, 'admin').allowed) redirect('/schedules');
  const options = await scheduleFormOptions(getDb());
  return (
    <>
      <PageTitle>新增排程</PageTitle>
      <Card>
        <ScheduleForm
          action={saveScheduleAction.bind(null, null)}
          initial={{ name: '每日報告', template: 'daily_report', cron: '0 9 * * *', tz: 'Asia/Taipei', accountIds: [], channelId: '', extraInstructions: '', enabled: true }}
          {...options}
        />
      </Card>
    </>
  );
}
