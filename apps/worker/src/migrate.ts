// Applies pending database migrations, then exits. In the image: `docker compose run --rm worker migrate`.
import { EnvSchema, parseEnv } from '@arlo/config';
import { createLogger } from '@arlo/config/logger';
import { createPool } from '@arlo/db';
// Separate entry point: web bundles @arlo/db and must not pull in the migrations folder.
import { runMigrations } from '@arlo/db/migrate';

const logger = createLogger({ component: 'migrate' });

try {
  const env = parseEnv(EnvSchema.pick({ DATABASE_URL: true }));
  const pool = createPool({ connectionString: env.DATABASE_URL, logger });
  try {
    await runMigrations(pool, { logger });
  } finally {
    await pool.end();
  }
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exitCode = 1;
}
