import { fileURLToPath } from 'node:url';
import type { Logger } from '@arlo/config/logger';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from './client';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

// Arbitrary constant shared by every migration run; serializes concurrent deploys.
const MIGRATION_LOCK_KEY = 4_217_001;

export interface RunMigrationsOptions {
  logger: Logger;
  migrationsFolder?: string;
}

export async function runMigrations(pool: Pool, { logger, migrationsFolder = MIGRATIONS_FOLDER }: RunMigrationsOptions): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      logger.info({ migrationsFolder }, 'running migrations');
      await migrate(drizzle({ client }), { migrationsFolder });
      logger.info('migrations complete');
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
