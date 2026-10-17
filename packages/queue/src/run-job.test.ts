import { createLogger } from '@arlo/config/logger';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineJob, runJob, summarizeOutput } from './registry';
import { jobSpec } from './spec';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ component: 'test', level: 'debug' }, { write: (s: string) => void lines.push(JSON.parse(s)) });
  return { logger, lines };
}

const Spec = jobSpec('test.run', z.object({ accountId: z.uuid().optional(), token: z.string().optional() }));
const job = (data: unknown, retryCount = 0) => ({ id: 'job-1', data, retryCount, signal: new AbortController().signal });

describe('runJob', () => {
  it('logs completion with duration and a numeric/boolean summary, not the payload', async () => {
    const { logger, lines } = capture();
    const def = defineJob(Spec, async () => ({ accounts: 3, skipped: false, note: 'free text', cleanup: { deleted: 1 } }));
    const result = await runJob(def, job({ token: 'secret-value' }), logger);

    expect(result).toEqual({ id: 'job-1', status: 'completed', output: { accounts: 3, skipped: false, note: 'free text', cleanup: { deleted: 1 } } });
    expect(lines).toEqual([
      expect.objectContaining({ level: 'info', msg: 'job completed', job_id: 'job-1', job: 'test.run', retry_count: 0, result: { accounts: 3, skipped: false } }),
    ]);
    expect(lines[0]!.duration_ms).toEqual(expect.any(Number));
    expect(JSON.stringify(lines)).not.toContain('secret-value');
  });

  it('logs completion at debug when the job asks for it', async () => {
    const { logger, lines } = capture();
    const def = defineJob(Spec, async () => ({ expired: 0 }), { completedLogLevel: 'debug' });
    await runJob(def, job({}), logger);
    expect(lines).toEqual([expect.objectContaining({ level: 'debug', msg: 'job completed', result: { expired: 0 } })]);
  });

  it('logs the error and rethrows so pg-boss retries', async () => {
    const { logger, lines } = capture();
    const def = defineJob(Spec, async () => {
      throw Object.assign(new Error('USER_PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' });
    });
    await expect(runJob(def, job({}, 2), logger)).rejects.toThrow('USER_PERMISSION_DENIED');
    expect(lines).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'job failed',
        job_id: 'job-1',
        job: 'test.run',
        retry_count: 2,
        duration_ms: expect.any(Number),
        err: expect.objectContaining({ message: 'USER_PERMISSION_DENIED', code: 'PERMISSION_DENIED' }),
      }),
    ]);
  });

  it('warns on an invalid payload and dead-letters it without running the handler', async () => {
    const { logger, lines } = capture();
    let called = false;
    const def = defineJob(Spec, async () => {
      called = true;
    });
    const result = await runJob(def, job({ accountId: 'not-a-uuid', token: 'secret-value' }), logger);

    expect(called).toBe(false);
    expect(result).toEqual({ id: 'job-1', status: 'deadletter', output: { error: 'invalid_payload' } });
    expect(lines).toEqual([expect.objectContaining({ level: 'warn', msg: 'invalid job payload', job_id: 'job-1', issues: [expect.objectContaining({ path: ['accountId'] })] })]);
    expect(JSON.stringify(lines)).not.toContain('secret-value');
  });
});

describe('summarizeOutput', () => {
  it.each([
    [undefined, undefined],
    [null, undefined],
    ['done', undefined],
    [[1, 2], undefined],
    [{ status: 'ok' }, undefined],
    [{ accounts: 2, cleanup: undefined }, { accounts: 2 }],
    [{ written: 10, skipped: true, ids: ['a'] }, { written: 10, skipped: true }],
  ])('%j → %j', (output, expected) => {
    expect(summarizeOutput(output)).toEqual(expected);
  });
});
