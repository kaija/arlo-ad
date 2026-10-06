// Producer-side pg-boss for route handlers: Slack endpoints ack within 3 seconds and hand the
// work to the worker (Requirement 7.7).
import { createBoss, enqueue, type JobData, type JobSpec, type PgBoss } from '@arlo/queue';
import { EnvSchema, parseEnv } from '@arlo/config';
import { logger } from './server';

const cache = globalThis as typeof globalThis & { arloBoss?: Promise<PgBoss> };

export function getBoss(): Promise<PgBoss> {
  cache.arloBoss ??= (async () => {
    const env = parseEnv(EnvSchema.pick({ DATABASE_URL: true }));
    const boss = createBoss({ connectionString: env.DATABASE_URL, logger, role: 'producer' });
    try {
      return await boss.start();
    } catch (err) {
      cache.arloBoss = undefined;
      throw err;
    }
  })();
  return cache.arloBoss;
}

export async function enqueueJob<J extends JobSpec>(spec: J, data: JobData<J>): Promise<string> {
  return enqueue(await getBoss(), spec, data);
}
