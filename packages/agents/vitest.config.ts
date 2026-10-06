import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@arlo/agents',
    globalSetup: ['@arlo/db/testing/global-setup'],
  },
});
