import type { Logger } from '@arlo/config/logger';

export interface ShutdownOptions {
  logger: Logger;
  timeoutMs?: number;
  exit?: (code: number) => void;
}

export interface Shutdown {
  /** Closers run in reverse registration order: register dependencies (db) before their users (servers, queue). */
  register(name: string, close: () => Promise<void>): void;
  shutdown(reason: string, exitCode?: number): Promise<void>;
  /** Installs SIGTERM/SIGINT handlers; a second signal falls through to Node's default and kills the process. */
  listen(signals?: NodeJS.Signals[]): void;
}

export function createShutdown({ logger, timeoutMs = 10_000, exit = (code) => process.exit(code) }: ShutdownOptions): Shutdown {
  const closers: { name: string; close: () => Promise<void> }[] = [];
  let pending: Promise<void> | undefined;

  const shutdown = (reason: string, exitCode = 0): Promise<void> => {
    pending ??= (async () => {
      logger.info({ reason }, 'shutting down');
      const timer = setTimeout(() => {
        logger.error({ timeoutMs }, 'shutdown timed out');
        exit(1);
      }, timeoutMs);
      timer.unref();
      let code = exitCode;
      for (const { name, close } of [...closers].reverse()) {
        try {
          await close();
        } catch (err) {
          code = 1;
          logger.error({ err, closer: name }, 'shutdown step failed');
        }
      }
      clearTimeout(timer);
      logger.info({ code }, 'shutdown complete');
      exit(code);
    })();
    return pending;
  };

  return {
    register: (name, close) => void closers.push({ name, close }),
    shutdown,
    listen: (signals = ['SIGTERM', 'SIGINT']) => {
      for (const signal of signals) process.once(signal, () => void shutdown(signal));
    },
  };
}
