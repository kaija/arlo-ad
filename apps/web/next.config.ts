import { EnvSchema, parseEnv } from '@arlo/config';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const env = parseEnv(EnvSchema.pick({ ALLOWED_DEV_ORIGINS: true }));

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image (infra/docker/Dockerfile.web).
  output: 'standalone',
  // Trace files from the monorepo root so workspace packages land in the standalone output.
  outputFileTracingRoot: import.meta.dirname + '/../..',
  // Workspace packages export TypeScript source directly.
  transpilePackages: ['@arlo/adapters', '@arlo/config', '@arlo/core', '@arlo/db', '@arlo/queue'],
  // `next dev` only accepts localhost unless the host is listed here.
  allowedDevOrigins: env.ALLOWED_DEV_ORIGINS,
};

export default createNextIntlPlugin('./i18n/request.ts')(nextConfig);
