import type { Logger } from '@arlo/config/logger';
import pg from 'pg';

export type Pool = pg.Pool;

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
