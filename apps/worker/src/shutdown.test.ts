import { createLogger } from '@arlo/config/logger';
import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from './shutdown';

const logger = createLogger({ component: 'test', level: 'silent' });

describe('createShutdown', () => {
  it('runs closers in reverse order and exits 0', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const s = createShutdown({ logger, exit });
    s.register('db', async () => void order.push('db'));
    s.register('server', async () => void order.push('server'));
    await s.shutdown('SIGTERM');
    expect(order).toEqual(['server', 'db']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('keeps closing after a failed step and exits 1', async () => {
    const exit = vi.fn();
    const db = vi.fn(async () => {});
    const s = createShutdown({ logger, exit });
    s.register('db', db);
    s.register('server', async () => {
      throw new Error('boom');
    });
    await s.shutdown('SIGTERM');
    expect(db).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('runs only once when signalled repeatedly', async () => {
    const exit = vi.fn();
    const close = vi.fn(async () => {});
    const s = createShutdown({ logger, exit });
    s.register('db', close);
    await Promise.all([s.shutdown('SIGTERM'), s.shutdown('SIGINT')]);
    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('uses the given exit code for fatal reasons', async () => {
    const exit = vi.fn();
    await createShutdown({ logger, exit }).shutdown('uncaughtException', 1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('forces exit 1 when a closer hangs past the timeout', async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const s = createShutdown({ logger, exit, timeoutMs: 1_000 });
      s.register('stuck', () => new Promise(() => {}));
      void s.shutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
