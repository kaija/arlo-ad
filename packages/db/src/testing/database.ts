import { randomBytes } from 'node:crypto';
import { createLogger } from '@arlo/config/logger';
import { afterAll, beforeAll, inject } from 'vitest';
import { createDb, createPool, type Db, type Pool } from '../client';
import { databaseUrl } from './postgres';

export interface TestDatabase {
  name: string;
  url: string;
  pool: Pool;
  db: Db;
  drop(): Promise<void>;
}

export interface TestDatabaseOptions {
  /** false: an empty database instead of a clone of the migrated template. */
  migrated?: boolean;
}

const logger = createLogger({ component: 'test-db', level: 'silent' });
const OBJECT_IN_USE = '55006';

/** Creates an isolated database for one test file. Needs the @arlo/db/testing/global-setup globalSetup. */
export async function createTestDatabase({ migrated = true }: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const { adminUrl, template } = inject('arloTestPostgres');
  const name = `test_${randomBytes(6).toString('hex')}`;
  const admin = createPool({ connectionString: adminUrl, logger, max: 1 });
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.query(`CREATE DATABASE ${name} TEMPLATE ${migrated ? template : 'template0'}`);
        break;
      } catch (err) {
        // Concurrent clones of the same template can briefly conflict.
        if ((err as { code?: string }).code !== OBJECT_IN_USE || attempt === 10) throw err;
        await new Promise((r) => setTimeout(r, 50 * attempt));
      }
    }
  } finally {
    await admin.end();
  }

  const url = databaseUrl(adminUrl, name);
  const pool = createPool({ connectionString: url, logger });
  return {
    name,
    url,
    pool,
    db: createDb(pool),
    async drop() {
      await pool.end();
      const cleanup = createPool({ connectionString: adminUrl, logger, max: 1 });
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/** Registers beforeAll/afterAll hooks; the returned object is populated before tests run. */
export function useTestDatabase(options?: TestDatabaseOptions): TestDatabase {
  const ctx = {} as TestDatabase;
  beforeAll(async () => {
    Object.assign(ctx, await createTestDatabase(options));
  }, 60_000);
  afterAll(async () => {
    await ctx.drop?.();
  });
  return ctx;
}
