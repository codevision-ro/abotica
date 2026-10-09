/** Tool permission rules. Pure and client-safe: no database or server imports. */
import type { AgentKind, ToolPermission, ToolPermissions } from "@abotica/db";
import { TOOL_CATALOG, type ToolInfo } from "./tools/tool-catalog";

export type { ToolPermission, ToolPermissions };

/** Display order: least to most restrictive. */
export const TOOL_PERMISSIONS = ["allow", "ask", "deny"] as const satisfies readonly ToolPermission[];

/**
 * Starting permission of every MCP tool the agent set nothing for. Agents do what an employee would, so a
 * tool's hints (read-only, destructive) describe it but do not hold it back; the user can still choose
 * ask or deny per tool, per server or for every server.
 */
export const MCP_DEFAULT_PERMISSION: ToolPermission = "allow";
export const MCP_ALL_KEY = "mcp:*";

export const mcpServerKey = (serverSlug: string) => `mcp:${serverSlug}`;
export const mcpToolKey = (serverSlug: string, tool: string) => `mcp:${serverSlug}/${tool}`;

const TOOL_BY_NAME = new Map(TOOL_CATALOG.map((t) => [t.name, t]));

/** What a built-in tool the agent can have starts at, and what it gets without an entry. */
const BUILTIN_DEFAULT_PERMISSION: ToolPermission = "allow";

/** Who the permissions are for: the super agent, a manager or a specialist (see agents.kind). */
export type PermissionSubject = { kind: AgentKind };

/**
 * Whether an agent of this kind can have the built-in tool at all (the permissions editor lists only those).
 * Orchestrator-only tools are out of reach of everyone else, except the ones managers get too; a tool for
 * some kinds only is out of reach of the others.
 */
export function toolAvailableTo(tool: ToolInfo, subject: PermissionSubject): boolean {
  if (tool.kinds && !tool.kinds.includes(subject.kind)) return false;
  return !tool.orchestratorOnly || subject.kind === "orchestrator" || Boolean(tool.managers && subject.kind === "manager");
}

/**
 * Effective permission of a built-in tool: the agent's entry, else allow. Unknown tools and tools the
 * agent's kind cannot have are denied whatever is stored.
 */
export function builtinPermission(permissions: ToolPermissions, name: string, opts: PermissionSubject): ToolPermission {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool || !toolAvailableTo(tool, opts)) return "deny";
  return permissions[name] ?? BUILTIN_DEFAULT_PERMISSION;
}

/** Permission an MCP tool without an entry of its own inherits: its server's entry, then "mcp:*", then allow. */
export function mcpServerPermission(permissions: ToolPermissions, serverSlug: string): ToolPermission {
  return permissions[mcpServerKey(serverSlug)] ?? permissions[MCP_ALL_KEY] ?? MCP_DEFAULT_PERMISSION;
}

/** Effective permission of one MCP tool: its entry, then its server's, then "mcp:*", then allow. */
export function mcpToolPermission(permissions: ToolPermissions, serverSlug: string, tool: string): ToolPermission {
  return permissions[mcpToolKey(serverSlug, tool)] ?? mcpServerPermission(permissions, serverSlug);
}

/** Permissions of a new agent: every tool it can have, allowed. */
export function defaultPermissions(opts: PermissionSubject): ToolPermissions {
  const out: ToolPermissions = {};
  for (const tool of TOOL_CATALOG) {
    if (toolAvailableTo(tool, opts)) out[tool.name] = BUILTIN_DEFAULT_PERMISSION;
  }
  return out;
}

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const MCP_KEY_RE = new RegExp(`^mcp:(?:\\*|${SLUG}(?:/.{1,200})?)$`);
const isPermission = (value: unknown): value is ToolPermission =>
  typeof value === "string" && (TOOL_PERMISSIONS as readonly string[]).includes(value);

/**
 * Drops unknown keys, invalid values and built-in tools the agent's kind cannot have. Denials are kept
 * as entries: a built-in tool without one is allowed.
 */
export function sanitizePermissions(input: Record<string, unknown>, opts: PermissionSubject): ToolPermissions {
  const out: ToolPermissions = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isPermission(value)) continue;
    if (key.startsWith("mcp:")) {
      if (MCP_KEY_RE.test(key)) out[key] = value;
      continue;
    }
    const tool = TOOL_BY_NAME.get(key);
    if (tool && toolAvailableTo(tool, opts)) out[key] = value;
  }
  return out;
}
