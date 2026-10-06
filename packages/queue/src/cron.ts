import { PgBoss } from 'pg-boss';

// previewSchedule needs no connection; this instance is never started.
let previewer: PgBoss | undefined;

export type CronPreview = { ok: true; next: Date[] } | { ok: false; error: string };

/** Validates a cron expression in a timezone the way pg-boss will evaluate it, with the next runs. */
export function previewCron(cron: string, tz: string, opts: { from?: Date; count?: number } = {}): CronPreview {
  previewer ??= new PgBoss({ connectionString: 'postgres://preview@localhost/preview' });
  try {
    return { ok: true, next: previewer.previewSchedule(cron.trim(), { tz, from: opts.from ?? new Date(), count: opts.count ?? 3 }) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
