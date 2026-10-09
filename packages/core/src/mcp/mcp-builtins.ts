/**
 * MCP servers that ship with Abotica. The worker keeps a row per entry in `mcp_servers` (with
 * `builtin` set to the key) whose connection settings follow this catalog; the user decides only
 * whether it is enabled, offered to every agent, and its optional API key. Pure and client-safe.
 *
 * The stdio servers are preinstalled in the sandbox image (Dockerfile, `sandbox` stage) and share
 * one Chromium: the revision Scrapling's patchright is built for, because its stealth only works on
 * that one. Playwright MCP is pinned to the release on the same revision; bump them together.
 */
import type { NetworkPolicy } from "@abotica/db";

export type BuiltinMcpKey = "parallel-search" | "context7" | "playwright" | "scrapling";

type BuiltinBase = {
  key: BuiltinMcpKey;
  slug: string;
  name: string;
  /** Where its documentation lives, shown on its card. */
  docsUrl: string;
  /**
   * Tools of the server no agent gets. Only for what would cross the one line Abotica keeps: a tool that
   * runs code as the MCP user could read the other MCP servers' credentials from their processes.
   */
  hiddenTools?: readonly string[];
};

type BuiltinHttpMcp = BuiltinBase & {
  transport: "http";
  url: string;
  /**
   * Vault secret that raises the anonymous limits. Sent as a bearer token when it is set; without
   * it the server is used anonymously.
   */
  apiKeySecret: string;
};

type BuiltinStdioMcp = BuiltinBase & {
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
    // Runs JavaScript in the server's own Node process (its description says "RCE-equivalent"): as the
    // MCP user it could read the other MCP servers' environments, where their keys are. Page scripts
    // (browser_evaluate) run in the browser and stay available.
    hiddenTools: ["browser_run_code_unsafe"],
    transport: "stdio",
    command: "abotica-proxy-run",
    // Fresh profile per run. Screenshots land in the folder it starts in, which in a run's workspace
    // is outside the volume and readable by the agent (`mcpOutputFolder`): it can share them from
    // there, and Playwright reads and writes files only inside that folder. Screenshots also go to
    // the model with the answer, so an agent can see the page it builds (a model that reads no
    // images gets a line saying so, see input-modalities.ts). Loopback skips the proxy, which
    // refuses it, so the browser opens the servers the agent runs in the workspace.
    args: [
      "playwright-mcp",
      "--headless",
      "--isolated",
      "--browser",
      "chromium",
      "--proxy-server={proxy}",
      "--proxy-bypass",
      "localhost,127.0.0.1,[::1]",
      "--output-dir",
      ".",
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

/** The tool definitions of a server without the ones its bundled entry hides from agents (`hiddenTools`). */
export function withoutHiddenTools<T extends { name: string }>(builtin: string | null | undefined, tools: T[]): T[] {
  const hidden = builtinMcp(builtin)?.hiddenTools;
  return hidden?.length ? tools.filter((tool) => !hidden.includes(tool.name)) : tools;
}
