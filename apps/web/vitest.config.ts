import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@arlo/web',
    globalSetup: ['@arlo/db/testing/global-setup'],
  },
});
