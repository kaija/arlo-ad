import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export const POSTGRES_IMAGE = 'postgres:18-alpine';

// Starts a throwaway Postgres for integration tests. Requires a running Docker daemon.
export async function startTestPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(POSTGRES_IMAGE).start();
}

export function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export interface TestPostgresInfo {
  /** Connection URL to the `postgres` maintenance database (superuser). */
  adminUrl: string;
  template: string;
}

// Provided by global-setup.ts, read with inject() in test files. Declared here so every
// program that reaches the harness through imports sees the type.
declare module 'vitest' {
  export interface ProvidedContext {
    arloTestPostgres: TestPostgresInfo;
  }
}
