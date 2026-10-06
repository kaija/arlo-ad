import type { Logger } from '@arlo/config/logger';
import type { CheckResult } from '@arlo/core';
import type { PgBoss } from 'pg-boss';

/** pg-boss schema reachable and installed. Failures report a short code only (public healthz). */
export async function checkQueue(boss: PgBoss, { logger, timeoutMs = 2_000 }: { logger: Logger; timeoutMs?: number }): Promise<CheckResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let timer: NodeJS.Timeout | undefined;
  try {
    const installed = await Promise.race([
      boss.isInstalled(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('health check timed out'), { code: 'timeout' })), timeoutMs);
      }),
    ]);
    return installed ? { ok: true, latencyMs: elapsed() } : { ok: false, latencyMs: elapsed(), error: 'not_installed' };
  } catch (err) {
    logger.warn({ err }, 'queue health check failed');
    const code = (err as { code?: unknown } | null)?.code;
    return { ok: false, latencyMs: elapsed(), error: typeof code === 'string' && code ? code : 'error' };
  } finally {
    clearTimeout(timer);
  }
}
