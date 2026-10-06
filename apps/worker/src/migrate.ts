// Applies pending database migrations, installs the pg-boss schema and creates its queues,
// then exits. In the image: `docker compose run --rm worker migrate`.
import { EnvSchema, parseEnv } from '@arlo/config';
import { createLogger } from '@arlo/config/logger';
import { createPool } from '@arlo/db';
// Separate entry point: web bundles @arlo/db and must not pull in the migrations folder.
import { runMigrations } from '@arlo/db/migrate';
import { ALL_JOBS, createBoss, ensureQueues } from '@arlo/queue';

const logger = createLogger({ component: 'migrate' });

try {
  const env = parseEnv(EnvSchema.pick({ DATABASE_URL: true }));
  const pool = createPool({ connectionString: env.DATABASE_URL, logger });
  try {
    await runMigrations(pool, { logger });
  } finally {
    await pool.end();
  }
  // Queues must exist before web can enqueue, even if the worker has never started.
  const boss = createBoss({ connectionString: env.DATABASE_URL, logger, role: 'migrator', max: 1 });
  await boss.start();
  try {
    await ensureQueues(boss, ALL_JOBS);
    logger.info({ queues: ALL_JOBS.length }, 'queues ready');
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exitCode = 1;
}
