import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // In dev, Next may proxy requests based on the request origin/host.
  // Allow common local origins so `next dev --hostname 127.0.0.1` works
  // when users access via http://localhost:3000 or http://127.0.0.1:3000.
  // Keep the LAN IP as well for dev on the local network.
  allowedDevOrigins: ["192.168.1.101", "localhost", "127.0.0.1"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "img.clerk.com",
      },
    ],
  },
  /**
   * Same-origin proxy from the frontend to the FastAPI backend.
   *
   * In production behind Cloudflare Tunnel we want exactly one public route
   * (`mc.example.com → http://localhost:3000`). The browser then sees every
   * API call as same-origin (`/api/v1/...`), so cookies/CORS stay simple
   * and the operator doesn't need a second tunnel hostname. The Next.js
   * server forwards to `http://backend:8000` over the internal Docker
   * network.
   *
   * `BACKEND_INTERNAL_URL` is read at runtime (Next evaluates `rewrites`
   * on the server side) so deployments that don't use Docker Compose can
   * point it elsewhere — defaulting to the compose service name keeps the
   * happy path zero-config.
   */
  async rewrites() {
    const backendUrl =
      process.env.BACKEND_INTERNAL_URL?.trim() || "http://backend:8000";
    return [
      {
        source: "/api/v1/:path*",
        destination: `${backendUrl}/api/v1/:path*`,
      },
      // Backend exposes the three infra probes at the root (see
      // `backend/app/main.py:505-520`) — Cloudflare Tunnel + the
      // sidebar's `useHealthzHealthzGet()` (DashboardSidebar.tsx)
      // both hit `/healthz` directly, so we need to proxy it too.
      // Without these rewrites the request falls through to Next's
      // 404 page and the sidebar shows "System degraded" perpetually.
      { source: "/healthz", destination: `${backendUrl}/healthz` },
      { source: "/health", destination: `${backendUrl}/health` },
      { source: "/readyz", destination: `${backendUrl}/readyz` },
    ];
  },
};

export default nextConfig;
