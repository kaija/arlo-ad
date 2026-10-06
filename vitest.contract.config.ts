import { defineConfig } from 'vitest/config';

// Contract tests hit the Google Ads test account (ADR-0026). Manual only: `pnpm test:contract`.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.contract.ts'],
    testTimeout: 60_000,
  },
});
