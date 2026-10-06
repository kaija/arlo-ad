// Vitest globalSetup: one Postgres container per test run, with a migrated template database
// that each test file clones (see useTestDatabase). Add to a project's vitest.config.ts:
//   test: { globalSetup: ['@arlo/db/testing/global-setup'] }
import type { TestProject } from 'vitest/node';
import { createLogger } from '@arlo/config/logger';
import { createPool } from '../client';
import { runMigrations } from '../migrate';
import { databaseUrl, startTestPostgres } from './postgres';

export const TEMPLATE_DATABASE = 'arlo_template';

export default async function setup(project: TestProject) {
  const logger = createLogger({ component: 'test-postgres', level: 'warn' });
  const container = await startTestPostgres();
  const adminUrl = databaseUrl(container.getConnectionUri(), 'postgres');

  const admin = createPool({ connectionString: adminUrl, logger, max: 1 });
  await admin.query(`CREATE DATABASE ${TEMPLATE_DATABASE}`);
  const template = createPool({ connectionString: databaseUrl(adminUrl, TEMPLATE_DATABASE), logger, max: 1 });
  try {
    await runMigrations(template, { logger });
  } finally {
    await template.end();
  }
  // Cloning requires that nothing is connected to the template.
  await admin.query(`ALTER DATABASE ${TEMPLATE_DATABASE} WITH ALLOW_CONNECTIONS false`);
  await admin.end();

  project.provide('arloTestPostgres', { adminUrl, template: TEMPLATE_DATABASE });
  return () => container.stop();
}
