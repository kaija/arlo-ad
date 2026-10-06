import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { Logger } from '@arlo/config/logger';
import { runHealthChecks, type HealthCheck } from '@arlo/core';

export interface HealthServerOptions {
  port: number;
  host?: string;
  checks: Record<string, HealthCheck>;
  logger: Logger;
}

export async function startHealthServer({ port, host = '0.0.0.0', checks, logger }: HealthServerOptions): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url?.split('?')[0] !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    runHealthChecks(checks).then(
      ({ httpStatus, body }) => {
        res.writeHead(httpStatus, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      },
      (err: unknown) => {
        logger.error({ err }, 'health check handler failed');
        res.writeHead(500).end();
      },
    );
  });
  server.listen(port, host);
  await once(server, 'listening');
  return server;
}

export async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  server.closeIdleConnections();
  await closed;
}
