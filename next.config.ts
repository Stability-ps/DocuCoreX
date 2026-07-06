import type { NextConfig } from "next";

// Base hardening applied to every route (no framing directive here).
const baseSecurityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

// The inline preview endpoints must be embeddable in the same-origin document
// viewer, so they are NOT covered by the X-Frame-Options: DENY rule (which
// targets page routes). Framing is restricted to same-origin via CSP instead.
const PREVIEW_SOURCES = ["/api/documents/:id/preview", "/api/accounting/fnb/runs/:id/source"];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      // Base security headers everywhere.
      { source: "/(.*)", headers: baseSecurityHeaders },
      // Deny framing on normal app pages only (exclude /api so the viewer can
      // embed the same-origin preview routes).
      { source: "/((?!api/).*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] },
      // Preview routes: allow same-origin framing, block cross-origin.
      ...PREVIEW_SOURCES.map((source) => ({
        source,
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self'" }],
      })),
    ];
  },
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
