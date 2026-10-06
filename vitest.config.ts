import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'apps/*',
      'packages/*',
      'evals',
      { test: { name: 'repo', include: ['tests/**/*.test.ts'] } },
    ],
  },
});
