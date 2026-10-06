import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@arlo/worker',
    globalSetup: ['@arlo/db/testing/global-setup'],
  },
});
