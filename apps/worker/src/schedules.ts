// System cron schedules (UTC). User-defined report schedules live in scheduled_jobs (ADR-0016).
import type { PgBoss } from '@arlo/queue';
import { Jobs } from '@arlo/queue';

export const SYSTEM_SCHEDULES = [
  { name: Jobs.syncSnapshots.name, cron: '*/15 * * * *' },
  { name: Jobs.syncHourly.name, cron: '5 * * * *' },
  // 06:00 UTC: yesterday is complete in Asia and Europe; D-3..D-1 covers the Americas too.
  { name: Jobs.syncDaily.name, cron: '0 6 * * *' },
] as const;

export async function applySystemSchedules(boss: PgBoss): Promise<void> {
  for (const s of SYSTEM_SCHEDULES) await boss.schedule(s.name, s.cron, {}, { tz: 'UTC' });
}
