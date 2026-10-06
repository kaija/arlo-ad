import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@arlo/queue',
    globalSetup: ['@arlo/db/testing/global-setup'],
  },
});
