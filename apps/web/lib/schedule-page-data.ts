import { JOB_TEMPLATES, resolveAccounts, type Db } from '@arlo/db';
import { TEMPLATE_LABELS } from './schedules';
import { listBotChannels } from './slack-channels';

const COMMON_TZ = ['Asia/Taipei', 'Asia/Tokyo', 'Asia/Singapore', 'UTC', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];

/** Options shared by the new / edit schedule forms. */
export async function scheduleFormOptions(db: Db) {
  const [accounts, channels] = await Promise.all([resolveAccounts(db, { allowed: null }), listBotChannels()]);
  return {
    templates: JOB_TEMPLATES.map((t) => ({ value: t, label: TEMPLATE_LABELS[t] })),
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, externalId: a.externalId })),
    channels,
    timeZones: [...new Set([...COMMON_TZ, ...Intl.supportedValuesOf('timeZone')])],
  };
}
