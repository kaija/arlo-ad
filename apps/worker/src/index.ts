import { EnvSchema, parseEnv } from '@arlo/config';
import { createLogger } from '@arlo/config/logger';
import { checkDatabase, createPool } from '@arlo/db';
import { closeServer, startHealthServer } from './health-server';
import { createShutdown } from './shutdown';

const logger = createLogger({ component: 'worker' });
const shutdown = createShutdown({ logger });
shutdown.listen();
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void shutdown.shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'unhandled rejection');
  void shutdown.shutdown('unhandledRejection', 1);
});

// Validate only the keys the worker uses so far; extend the pick as features land.
const WorkerEnv = EnvSchema.pick({ DATABASE_URL: true, WORKER_HEALTH_PORT: true });

function loadEnv() {
  try {
    return parseEnv(WorkerEnv);
  } catch (err) {
    logger.fatal({ err }, 'invalid configuration');
    process.exit(1);
  }
}

const env = loadEnv();
const healthPort = env.WORKER_HEALTH_PORT;

const pool = createPool({ connectionString: env.DATABASE_URL, logger });
shutdown.register('postgres', () => pool.end());

const server = await startHealthServer({
  port: healthPort,
  checks: { db: () => checkDatabase(pool, { logger }) },
  logger,
});
shutdown.register('health-server', () => closeServer(server));

logger.info({ healthPort }, 'worker started');
