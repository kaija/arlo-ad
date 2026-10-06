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

// TODO(task 1.4): read from the validated env schema in @arlo/config.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 9090);

const pool = createPool({ connectionString: databaseUrl, logger });
shutdown.register('postgres', () => pool.end());

const server = await startHealthServer({
  port: healthPort,
  checks: { db: () => checkDatabase(pool, { logger }) },
  logger,
});
shutdown.register('health-server', () => closeServer(server));

logger.info({ healthPort }, 'worker started');
