import type { Logger } from '@arlo/config/logger';
import type { CheckResult } from '@arlo/core';
import type { Pool } from './client';

export interface CheckDatabaseOptions {
  logger: Logger;
  timeoutMs?: number;
}

export async function checkDatabase(pool: Pool, { logger, timeoutMs = 2_000 }: CheckDatabaseOptions): Promise<CheckResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query('select 1'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('health check timed out'), { code: 'timeout' })), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: elapsed() };
  } catch (err) {
    logger.warn({ err }, 'database health check failed');
    return { ok: false, latencyMs: elapsed(), error: errorCode(err) };
  } finally {
    clearTimeout(timer);
  }
}

// pg SQLSTATE (e.g. 28P01) or Node errno code (e.g. ECONNREFUSED); never the message.
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : 'error';
}
