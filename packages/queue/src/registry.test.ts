import { createLogger } from '@arlo/config/logger';
import { useTestDatabase } from '@arlo/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBoss, enqueue, type PgBoss } from './boss';
import { checkQueue } from './health';
import { defineJob, registerJobs } from './registry';
import { jobSpec } from './spec';

const logger = createLogger({ component: 'test', level: 'silent' });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function waitForState(boss: PgBoss, name: string, id: string, state: string) {
  for (let i = 0; i < 100; i++) {
    const [job] = await boss.findJobs(name, { id });
    if (job?.state === state) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${id} never reached ${state}`);
}

describe('pg-boss job registry', () => {
  const t = useTestDatabase();
  let worker: PgBoss;
  let producer: PgBoss;

  const Echo = jobSpec('test.echo', z.object({ message: z.string(), n: z.number().int() }));
  const Flaky = jobSpec('test.flaky', z.object({ key: z.string() }), { retryLimit: 2, retryDelay: 1, retryBackoff: false });

  const echoed = deferred<{ message: string; n: number }>();
  const attempts: number[] = [];
  const flakyDone = deferred<number>();

  beforeAll(async () => {
    worker = createBoss({ connectionString: t.url, logger, role: 'worker' });
    await worker.start();
    await registerJobs(
      worker,
      [
        defineJob(Echo.name, Echo.schema, async (data) => echoed.resolve(data), { pollingIntervalSeconds: 0.5 }),
        defineJob(
          Flaky,
          async (_data, ctx) => {
            attempts.push(ctx.retryCount);
            if (ctx.retryCount === 0) throw new Error('transient');
            flakyDone.resolve(ctx.retryCount);
            return { ok: true };
          },
          { pollingIntervalSeconds: 0.5 },
        ),
      ],
      { logger },
    );
    // Web-style producer: no schema migration, maintenance or cron.
    producer = createBoss({ connectionString: t.url, logger, role: 'producer' });
    await producer.start();
  }, 60_000);

  afterAll(async () => {
    await producer?.stop({ graceful: false, close: true });
    await worker?.stop({ graceful: false, close: true });
  });

  it('delivers a validated payload from the producer to the handler', async () => {
    const id = await enqueue(producer, Echo, { message: 'hi', n: 1 });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(await echoed.promise).toEqual({ message: 'hi', n: 1 });
    await waitForState(worker, Echo.name, id, 'completed');
  });

  it('rejects invalid payloads before sending', async () => {
    await expect(enqueue(producer, Echo, { message: 'hi', n: 1.5 })).rejects.toThrow();
  });

  it('retries a failed handler and completes on the next attempt', async () => {
    const id = await enqueue(producer, Flaky, { key: 'a' });
    expect(await flakyDone.promise).toBe(1);
    expect(attempts).toEqual([0, 1]);
    const job = await waitForState(worker, Flaky.name, id, 'completed');
    expect(job.output).toEqual({ ok: true });
  });

  it('fails malformed payloads terminally without calling the handler', async () => {
    // Bypass enqueue validation to simulate a payload from an older producer.
    const id = (await producer.send(Echo.name, { message: 42 }))!;
    const job = await waitForState(worker, Echo.name, id, 'failed');
    expect(job.retryCount).toBe(0);
    expect(job.output).toMatchObject({ error: 'invalid_payload' });
  });

  it('reports queue health', async () => {
    expect(await checkQueue(producer, { logger })).toMatchObject({ ok: true });
  });

  it('applies retry defaults and per-queue overrides', async () => {
    expect(await worker.getQueue(Echo.name)).toMatchObject({ retryLimit: 5, retryBackoff: true });
    expect(await worker.getQueue(Flaky.name)).toMatchObject({ retryLimit: 2, retryBackoff: false });
  });
});
