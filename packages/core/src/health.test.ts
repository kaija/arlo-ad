import { describe, expect, it } from 'vitest';
import { runHealthChecks } from './health';

describe('runHealthChecks', () => {
  it('is ok with 200 when every check passes', async () => {
    const res = await runHealthChecks({
      db: async () => ({ ok: true, latencyMs: 3 }),
      queue: async () => ({ ok: true, latencyMs: 1 }),
    });
    expect(res).toEqual({
      httpStatus: 200,
      body: { status: 'ok', checks: { db: { ok: true, latencyMs: 3 }, queue: { ok: true, latencyMs: 1 } } },
    });
  });

  it('fails with 503 when any check fails', async () => {
    const res = await runHealthChecks({
      db: async () => ({ ok: false, latencyMs: 2000, error: 'timeout' }),
      queue: async () => ({ ok: true, latencyMs: 1 }),
    });
    expect(res.httpStatus).toBe(503);
    expect(res.body.status).toBe('fail');
    expect(res.body.checks.db).toEqual({ ok: false, latencyMs: 2000, error: 'timeout' });
  });

  it('reports a throwing check as failed without leaking the error', async () => {
    const res = await runHealthChecks({
      db: async () => {
        throw new Error('password authentication failed for user "arlo"');
      },
    });
    expect(res.httpStatus).toBe(503);
    expect(res.body.checks.db).toEqual({ ok: false, latencyMs: 0, error: 'check_threw' });
  });

  it('is ok with no checks', async () => {
    expect(await runHealthChecks({})).toEqual({ httpStatus: 200, body: { status: 'ok', checks: {} } });
  });
});
