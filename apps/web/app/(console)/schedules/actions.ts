'use server';

import { deleteScheduledJob } from '@arlo/db';
import { enqueue, Jobs } from '@arlo/queue';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getBoss } from '../../../lib/queue';
import { parseScheduleForm, saveSchedule, setScheduleEnabled, triggerSchedule, type FieldErrors } from '../../../lib/schedules';
import { getDb } from '../../../lib/server';
import { requireAuthorized } from '../../../lib/session';
import type { ScheduleFormValues } from '../../../components/schedule-form';

export interface ScheduleFormState {
  errors?: FieldErrors;
  /** What was submitted, so the form keeps it after React resets fields on a failed action. */
  values?: ScheduleFormValues;
}

function submitted(form: FormData): ScheduleFormValues {
  return {
    name: String(form.get('name') ?? ''),
    template: String(form.get('template') ?? ''),
    cron: String(form.get('cron') ?? ''),
    tz: String(form.get('tz') ?? ''),
    accountIds: form.getAll('accountIds').map(String),
    channelId: String(form.get('channelId') ?? ''),
    extraInstructions: String(form.get('extraInstructions') ?? ''),
    enabled: form.get('enabled') === 'on',
  };
}

// Schedules are settings (Requirement 18.4): admins only.
export async function saveScheduleAction(id: string | null, _prev: ScheduleFormState, form: FormData): Promise<ScheduleFormState> {
  const user = await requireAuthorized('admin');
  const parsed = parseScheduleForm(form);
  if (!parsed.ok) return { errors: parsed.errors, values: submitted(form) };
  const row = await saveSchedule(getDb(), await getBoss(), { id: id ?? undefined, value: parsed.value, userId: user.id });
  revalidatePath('/schedules');
  redirect(`/schedules/${row.id}?saved=1`);
}

export async function toggleScheduleAction(id: string, enabled: boolean): Promise<void> {
  await requireAuthorized('admin');
  await setScheduleEnabled(getDb(), await getBoss(), id, enabled);
  revalidatePath('/schedules');
  revalidatePath(`/schedules/${id}`);
}

export async function runScheduleAction(id: string): Promise<void> {
  await requireAuthorized('admin');
  await triggerSchedule(await getBoss(), id);
  revalidatePath(`/schedules/${id}`);
  redirect(`/schedules/${id}?triggered=1`);
}

export async function deleteScheduleAction(id: string): Promise<void> {
  await requireAuthorized('admin');
  await deleteScheduledJob(getDb(), id);
  await enqueue(await getBoss(), Jobs.schedulerSync, {});
  revalidatePath('/schedules');
  redirect('/schedules');
}
