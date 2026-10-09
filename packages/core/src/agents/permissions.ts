/** Tool permission rules. Pure and client-safe: no database or server imports. */
import type { AgentKind, ToolPermission, ToolPermissions } from "@abotica/db";
import { builtinMcp } from "../mcp/mcp-builtins";
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
 * Orchestrator-only tools are out of reach of everyone else, except the ones managers get too; a tool for
 * some kinds only is out of reach of the others.
 */
function unavailable(tool: ToolInfo, opts: PermissionSubject): boolean {
  if (tool.kinds && !tool.kinds.includes(opts.kind)) return true;
  return Boolean(tool.orchestratorOnly) && opts.kind !== "orchestrator" && !(tool.managers && opts.kind === "manager");
}

/** Whether an agent of this kind can have the built-in tool at all (the permissions editor lists only those). */
export const toolAvailableTo = (tool: ToolInfo, subject: PermissionSubject): boolean => !unavailable(tool, subject);

/**
 * Effective permission of a built-in tool: the agent's entry, else allow. Unknown tools and tools the
 * agent's kind cannot have are denied whatever is stored.
 */
export function builtinPermission(permissions: ToolPermissions, name: string, opts: PermissionSubject): ToolPermission {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool || unavailable(tool, opts)) return "deny";
  return permissions[name] ?? BUILTIN_DEFAULT_PERMISSION;
}

/** What an MCP tool declares about itself: it only reads, it only adds, it may destroy, or nothing usable. */
export type McpToolHint = "readOnly" | "nonDestructive" | "destructive" | "none";

/**
 * Reads the hints in a tool's annotations (MCP `ToolAnnotations`). Under the MCP defaults a tool that
 * is not read-only and omits `destructiveHint` is destructive; values that are not booleans count as missing.
 */
export function mcpToolHint(annotations?: Record<string, unknown>): McpToolHint {
  if (annotations?.readOnlyHint === true) return "readOnly";
  if (annotations?.destructiveHint === false) return "nonDestructive";
  if (annotations?.destructiveHint === true || annotations?.readOnlyHint === false) return "destructive";
  return "none";
}

/**
 * What an MCP tool starts at without an entry the user set: the choice Abotica makes for a bundled
 * server it ships (mcp-builtins.ts), else MCP_DEFAULT_PERMISSION. The annotations no longer change it:
 * they stay in the signature because callers pass what they know of the tool, and the editor shows them.
 */
export function mcpToolDefault(_annotations: Record<string, unknown> | undefined, builtin?: string | null): ToolPermission {
  return builtinMcp(builtin)?.defaultPermission ?? MCP_DEFAULT_PERMISSION;
}

/**
 * Permission an MCP tool without an entry of its own inherits: its server's entry, then "mcp:*", then
 * `toolDefault` (mcpToolDefault). For a tool not known yet that is MCP_DEFAULT_PERMISSION.
 */
export function mcpServerPermission(
  permissions: ToolPermissions,
  serverSlug: string,
  toolDefault: ToolPermission = MCP_DEFAULT_PERMISSION,
): ToolPermission {
  return permissions[mcpServerKey(serverSlug)] ?? permissions[MCP_ALL_KEY] ?? toolDefault;
}

/**
 * Effective permission of one MCP tool: tool entry, then server, then "mcp:*", then `toolDefault`
 * (mcpToolDefault). What the user set at any level wins over what the server declares.
 */
export function mcpToolPermission(
  permissions: ToolPermissions,
  serverSlug: string,
  tool: string,
  toolDefault: ToolPermission = MCP_DEFAULT_PERMISSION,
): ToolPermission {
  return permissions[mcpToolKey(serverSlug, tool)] ?? mcpServerPermission(permissions, serverSlug, toolDefault);
}

/** Effective permission of an MCP tool in a run: the agent's entries, then the tool's default. */
export function mcpRunPermission(
  permissions: ToolPermissions,
  source: { serverSlug: string; tool: string; defaultPermission: ToolPermission },
): ToolPermission {
  return mcpToolPermission(permissions, source.serverSlug, source.tool, source.defaultPermission);
}

/** Permissions of a new agent: every tool it can have, allowed. */
export function defaultPermissions(opts: PermissionSubject): ToolPermissions {
  const out: ToolPermissions = {};
  for (const tool of TOOL_CATALOG) {
    if (unavailable(tool, opts)) continue;
    out[tool.name] = BUILTIN_DEFAULT_PERMISSION;
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
    if (tool && !unavailable(tool, opts)) out[key] = value;
  }
  return out;
}
