/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lint runs as its own CI check; keep builds deterministic.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
