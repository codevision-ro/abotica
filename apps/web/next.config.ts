import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

/** Hosts from TRUSTED_ORIGINS (e.g. an ngrok tunnel): the app is also served there. */
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
  experimental: {
    serverActions: { bodySizeLimit: "20mb", allowedOrigins: extraHosts },
    proxyClientMaxBodySize: "20mb",
  },
};

// Picks up src/i18n/request.ts.
export default createNextIntlPlugin()(nextConfig);
