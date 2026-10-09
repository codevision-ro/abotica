/**
 * What the per-tool controls show for MCP tools and stores when one changes: the nearest level the user
 * set wins, and a tool with nothing set is allowed. Pure, so it is tested without a browser.
 */
import {
  mcpServerPermission,
  mcpToolKey,
  type ToolPermission,
  type ToolPermissions,
} from "@abotica/core/agents/permissions";
import type { McpToolInfo } from "@abotica/db";

/** The value of a control over several tools: theirs when they agree, else "mixed" (nothing selected). */
export const common = (values: ToolPermission[]): ToolPermission | "mixed" =>
  values.every((v) => v === values[0]) && values[0] ? values[0] : "mixed";

/** A tool matching what it would inherit (its server's setting, or allow) needs no entry of its own. */
export function withMcpTool(
  perms: ToolPermissions,
  server: { slug: string },
  tool: McpToolInfo,
  permission: ToolPermission,
): ToolPermissions {
  const next = { ...perms };
  const key = mcpToolKey(server.slug, tool.name);
  if (permission === mcpServerPermission(perms, server.slug)) delete next[key];
  else next[key] = permission;
  return next;
}

/** Everything back on: every built-in entry allowed, every MCP entry (all servers, a server, a tool) removed. */
export function withAllAllowed(perms: ToolPermissions): ToolPermissions {
  return Object.fromEntries(
    Object.keys(perms)
      .filter((key) => !key.startsWith("mcp:"))
      .map((key) => [key, "allow" as const]),
  );
}
