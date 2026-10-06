import type { Logger } from '@arlo/config/logger';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Pool = pg.Pool;
export type Db = NodePgDatabase<typeof schema>;

export interface PoolOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
}

export function createPool({ connectionString, logger, max = 10 }: PoolOptions): Pool {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
  // An idle client losing its connection emits 'error' on the pool; unhandled, it crashes the process.
  pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));
  return pool;
}

export function createDb(pool: Pool): Db {
  return drizzle({ client: pool, schema });
}
