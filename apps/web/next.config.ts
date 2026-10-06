import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image (infra/docker/Dockerfile.web).
  output: 'standalone',
  // Trace files from the monorepo root so workspace packages land in the standalone output.
  outputFileTracingRoot: import.meta.dirname + '/../..',
  // Workspace packages export TypeScript source directly.
  transpilePackages: ['@arlo/adapters', '@arlo/config', '@arlo/core', '@arlo/db', '@arlo/queue'],
};

export default nextConfig;
