import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages export TypeScript source directly.
  transpilePackages: ['@arlo/config', '@arlo/core', '@arlo/db'],
};

export default nextConfig;
