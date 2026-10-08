/**
 * What the permissions editor shows for MCP tools and stores when one changes: a level the user set
 * wins, and a tool without one shows the default from its hints. Pure, so it is tested without a browser.
 */
import {
  MCP_ALL_KEY,
  mcpServerKey,
  mcpServerPermission,
  mcpToolDefault,
  mcpToolKey,
  type ToolPermission,
  type ToolPermissions,
} from "@abotica/core/agents/permissions";
import type { McpToolInfo } from "@abotica/db";

type McpServerTools = { slug: string; builtin: string | null; tools: McpToolInfo[] | null };

/** The value of a control over several tools: theirs when they agree, else "mixed" (nothing selected). */
export const common = (values: ToolPermission[]): ToolPermission | "mixed" =>
  values.every((v) => v === values[0]) && values[0] ? values[0] : "mixed";

/** A tool matching what it would inherit (its server's setting, or its hints) needs no entry of its own. */
export function withMcpTool(
  perms: ToolPermissions,
  server: Pick<McpServerTools, "slug" | "builtin">,
  tool: McpToolInfo,
  permission: ToolPermission,
): ToolPermissions {
  const next = { ...perms };
  const key = mcpToolKey(server.slug, tool.name);
  if (permission === mcpServerPermission(perms, server.slug, mcpToolDefault(tool.annotations, server.builtin)))
    delete next[key];
  else next[key] = permission;
  return next;
}

/** Sets "mcp:*", or with null removes it, so every tool without a closer entry starts from its hints. */
export function withMcpDefault(perms: ToolPermissions, permission: ToolPermission | null): ToolPermissions {
  const next = { ...perms };
  if (permission) next[MCP_ALL_KEY] = permission;
  else delete next[MCP_ALL_KEY];
  return next;
}

/**
 * A server's control: what its tools without an entry of their own get, "mixed" when their hints give
 * different values. A server whose tools are not known shows the default of an unknown tool.
 */
export function mcpServerValue(perms: ToolPermissions, server: McpServerTools): ToolPermission | "mixed" {
  const tools = server.tools ?? [];
  if (!tools.length) return mcpServerPermission(perms, server.slug);
  return common(
    tools.map((tool) => mcpServerPermission(perms, server.slug, mcpToolDefault(tool.annotations, server.builtin))),
  );
}

/**
 * The "mcp:*" control: its entry, else what the tools of the listed servers without their own setting
 * start at from their hints ("mixed" when those differ or no tool is known).
 */
export function mcpDefaultValue(perms: ToolPermissions, servers: McpServerTools[]): ToolPermission | "mixed" {
  const setting = perms[MCP_ALL_KEY];
  if (setting) return setting;
  const covered = servers.filter((server) => perms[mcpServerKey(server.slug)] === undefined);
  return common(
    covered.flatMap((server) => (server.tools ?? []).map((tool) => mcpToolDefault(tool.annotations, server.builtin))),
  );
}
