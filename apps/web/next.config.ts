import type { NextConfig } from 'next';

const isProd = process.env.NODE_ENV === 'production';
const apiOrigin = process.env.API_ORIGIN ?? 'http://127.0.0.1:3000';

/**
 * Production: static export to `out/`, served same-origin by the NestJS API.
 * Development: `next dev` on :3001 proxies /api/* to the API so cookies stay same-origin.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@workforce/shared'],
  ...(isProd
    ? { output: 'export' as const, trailingSlash: true, images: { unoptimized: true } }
    : {
        async rewrites() {
          return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
        },
      }),
};

export default nextConfig;
