import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "docucorex.com" }],
        destination: "https://www.docucorex.com/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
