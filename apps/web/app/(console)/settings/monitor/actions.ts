'use server';

import { deleteMonitorRule, saveMonitorRule } from '@arlo/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { translateErrors } from '../../../../lib/i18n-server';
import { monitorFormValues, parseMonitorForm, type MonitorFormValues } from '../../../../lib/monitor-rules';
import { getDb } from '../../../../lib/server';
import { requireAuthorized } from '../../../../lib/session';

export interface MonitorFormState {
  errors?: Partial<Record<string, string>>;
  values?: MonitorFormValues;
}

// Monitor rules are settings (Requirement 18.4): admins only.
export async function saveMonitorAction(id: string | null, _prev: MonitorFormState, form: FormData): Promise<MonitorFormState> {
  const user = await requireAuthorized('admin');
  const values = monitorFormValues(form);
  const parsed = parseMonitorForm(values);
  if (!parsed.ok) return { errors: await translateErrors(parsed.errors), values };
  await saveMonitorRule(getDb(), { ...parsed.value, ...(id ? { id } : {}) }, { kind: 'user', id: user.id });
  revalidatePath('/settings/monitor');
  redirect('/settings/monitor?saved=1');
}

export async function deleteMonitorAction(id: string): Promise<void> {
  const user = await requireAuthorized('admin');
  await deleteMonitorRule(getDb(), id, { kind: 'user', id: user.id });
  revalidatePath('/settings/monitor');
  redirect('/settings/monitor');
}
