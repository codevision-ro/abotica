/**
 * MCP servers that ship with Abotica. The worker keeps a row per entry in `mcp_servers` (with
 * `builtin` set to the key) whose connection settings follow this catalog; the user decides only
 * whether it is enabled, offered to every agent, and its optional API key. Pure and client-safe.
 *
 * The stdio servers are preinstalled in the sandbox image (Dockerfile, `sandbox` stage) and share
 * one Chromium: the revision Scrapling's patchright is built for, because its stealth only works on
 * that one. Playwright MCP is pinned to the release on the same revision; bump them together.
 */
import type { NetworkPolicy, ToolPermission } from "@abotica/db";

export type BuiltinMcpKey = "parallel-search" | "context7" | "playwright" | "scrapling";

type BuiltinBase = {
  key: BuiltinMcpKey;
  slug: string;
  name: string;
  /** Where its documentation lives, shown on its card. */
  docsUrl: string;
  /**
   * What its tools start at for an agent that set nothing for them, instead of the default from each
   * tool's hints (agents/permissions.ts `mcpToolDefault`).
   */
  defaultPermission?: ToolPermission;
};

export type BuiltinHttpMcp = BuiltinBase & {
  transport: "http";
  url: string;
  /**
   * Vault secret that raises the anonymous limits. Sent as a bearer token when it is set; without
   * it the server is used anonymously.
   */
  apiKeySecret: string;
};

export type BuiltinStdioMcp = BuiltinBase & {
  transport: "stdio";
  command: string;
  args: string[];
  network: NetworkPolicy;
};

export type BuiltinMcp = BuiltinHttpMcp | BuiltinStdioMcp;

/**
 * `abotica-proxy-run` (packages/sandbox/image) puts a local proxy in front of the sandbox's egress
 * proxy: browsers cannot send its per-exec credentials themselves.
 */
export const BUILTIN_MCP_SERVERS: readonly BuiltinMcp[] = [
  {
    key: "parallel-search",
    slug: "parallel-search",
    name: "Parallel Search",
    docsUrl: "https://docs.parallel.ai/integrations/mcp/search-mcp",
    transport: "http",
    url: "https://search.parallel.ai/mcp",
    apiKeySecret: "PARALLEL_API_KEY",
  },
  {
    key: "context7",
    slug: "context7",
    name: "Context7",
    docsUrl: "https://github.com/upstash/context7",
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    apiKeySecret: "CONTEXT7_API_KEY",
  },
  {
    key: "playwright",
    slug: "playwright",
    name: "Playwright",
    docsUrl: "https://github.com/microsoft/playwright-mcp",
    // Browsing is clicks and typing, which Playwright MCP declares destructive: asking for each would
    // make the browser unusable. It runs in the sandbox with a fresh profile per run (--isolated).
    defaultPermission: "allow",
    transport: "stdio",
    command: "abotica-proxy-run",
    // Fresh profile per run. Screenshots land in the folder it starts in, which in a run's workspace
    // is outside the volume and readable by the agent (`mcpOutputFolder`): it can share them from
    // there, and Playwright reads and writes files only inside that folder. Images stay out of the
    // answers: not every model reads them, and the snapshot is the page.
    args: [
      "playwright-mcp",
      "--headless",
      "--isolated",
      "--browser",
      "chromium",
      "--proxy-server={proxy}",
      "--output-dir",
      ".",
      "--image-responses",
      "omit",
      "--codegen",
      "none",
    ],
    network: { mode: "full", domains: [] },
  },
  {
    key: "scrapling",
    slug: "scrapling",
    name: "Scrapling",
    docsUrl: "https://github.com/D4Vinci/Scrapling",
    transport: "stdio",
    command: "abotica-proxy-run",
    args: ["scrapling", "mcp"],
    network: { mode: "full", domains: [] },
  },
];

export const builtinMcp = (key: string | null | undefined): BuiltinMcp | undefined =>
  key ? BUILTIN_MCP_SERVERS.find((b) => b.key === key) : undefined;
