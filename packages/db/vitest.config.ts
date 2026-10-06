import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@arlo/db',
    globalSetup: ['./src/testing/global-setup.ts'],
  },
});
