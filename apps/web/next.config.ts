import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

/**
 * Hosts from TRUSTED_ORIGINS (e.g. an ngrok tunnel): the app is also served there. Parsed here
 * rather than with core's appOrigins(): this file runs during `next build`, where core's env()
 * would throw (it requires VAULT_KEY, which the image build does not have).
 */
const extraHosts = (process.env.TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((origin) =>
    origin
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, ""),
  )
  .filter(Boolean);

const nextConfig: NextConfig = {
  output: "standalone",
  // `next dev` blocks cross-origin requests for its own assets unless the host is listed.
  allowedDevOrigins: extraHosts,
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  // BullMQ loads Lua scripts from disk and ioredis uses native sockets; keep them unbundled.
  serverExternalPackages: ["bullmq", "ioredis", "@modelcontextprotocol/sdk"],
  // Server action arguments include API keys and secrets; never echo them to the dev log.
  logging: { serverFunctions: false },
  // Every response, API routes and static files included. Fixed at build time, so nothing here may
  // depend on APP_URL: the Content-Security-Policy and HSTS are set per request in proxy.ts.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // frame-ancestors 'none' in the CSP does the same for pages; this covers the other responses and older browsers.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
        ],
      },
    ];
  },
  experimental: {
    serverActions: { bodySizeLimit: "20mb", allowedOrigins: extraHosts },
    proxyClientMaxBodySize: "20mb",
  },
};

// Picks up src/i18n/request.ts.
export default createNextIntlPlugin()(nextConfig);
