/** Tool permission rules. Pure and client-safe: no database or server imports. */
import type { ToolPermission, ToolPermissions } from "@abotica/db";
import { TOOL_CATALOG, type ToolInfo } from "./tools/tool-catalog";

export type { ToolPermission, ToolPermissions };

/** Display order: least to most restrictive. */
export const TOOL_PERMISSIONS = ["allow", "ask", "deny"] as const satisfies readonly ToolPermission[];

/** Fallback for MCP tools when neither the tool, its server nor "mcp:*" has an entry. */
export const MCP_DEFAULT_PERMISSION: ToolPermission = "allow";
export const MCP_ALL_KEY = "mcp:*";

export const mcpServerKey = (serverSlug: string) => `mcp:${serverSlug}`;
export const mcpToolKey = (serverSlug: string, tool: string) => `mcp:${serverSlug}/${tool}`;

const TOOL_BY_NAME = new Map(TOOL_CATALOG.map((t) => [t.name, t]));

/** Tools that always need approval can be asked or denied, never allowed silently. */
export function clampPermission(tool: ToolInfo | undefined, permission: ToolPermission): ToolPermission {
  return tool?.alwaysAsk && permission === "allow" ? "ask" : permission;
}

/** Who the permissions are for: the super agent, a project manager, or another agent. */
export type PermissionSubject = { isOrchestrator: boolean; isManager: boolean };

/** Orchestrator-only tools are out of reach, except the ones managers get while they manage a project. */
function unavailable(tool: ToolInfo, opts: PermissionSubject): boolean {
  return Boolean(tool.orchestratorOnly) && !opts.isOrchestrator && !(tool.managers && opts.isManager);
}

/** Manager tools keep their entries for every other agent: there "deny" is stored, absence means the default. */
const keepsDenial = (tool: ToolInfo, opts: PermissionSubject) => Boolean(tool.managers) && !opts.isOrchestrator;

const defaultOf = (tool: ToolInfo) => clampPermission(tool, tool.defaultPermission ?? "allow");

/**
 * Effective permission of a built-in tool; missing or unavailable tools are denied. A manager tool
 * without an entry starts at its default, so an agent made manager can lead the project right away.
 */
export function builtinPermission(permissions: ToolPermissions, name: string, opts: PermissionSubject): ToolPermission {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool || unavailable(tool, opts)) return "deny";
  const stored = permissions[name];
  if (stored === undefined && keepsDenial(tool, opts)) return defaultOf(tool);
  return clampPermission(tool, stored ?? "deny");
}

/** Permission a server's tools inherit when they have no entry of their own. */
export function mcpServerPermission(permissions: ToolPermissions, serverSlug: string): ToolPermission {
  return permissions[mcpServerKey(serverSlug)] ?? permissions[MCP_ALL_KEY] ?? MCP_DEFAULT_PERMISSION;
}

/** Effective permission of one MCP tool: tool entry, then server, then "mcp:*", then allow. */
export function mcpToolPermission(permissions: ToolPermissions, serverSlug: string, tool: string): ToolPermission {
  return permissions[mcpToolKey(serverSlug, tool)] ?? mcpServerPermission(permissions, serverSlug);
}

/** Permissions of a new agent: every tool it can have, at the tool's default (always-ask tools ask). */
export function defaultPermissions(opts: PermissionSubject): ToolPermissions {
  const out: ToolPermissions = {};
  for (const tool of TOOL_CATALOG) {
    if (unavailable(tool, opts)) continue;
    out[tool.name] = defaultOf(tool);
  }
  return out;
}

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const MCP_KEY_RE = new RegExp(`^mcp:(?:\\*|${SLUG}(?:/.{1,200})?)$`);
const isPermission = (value: unknown): value is ToolPermission =>
  typeof value === "string" && (TOOL_PERMISSIONS as readonly string[]).includes(value);

/**
 * Drops unknown keys and invalid values, removes built-in tools the agent cannot have, stores
 * built-in denials as absence and clamps always-ask tools. Manager tools stay for every agent other
 * than the orchestrator, denials included: whether the agent manages a project changes over time.
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
    if (!tool) continue;
    if (keepsDenial(tool, opts)) {
      out[key] = clampPermission(tool, value);
      continue;
    }
    if (unavailable(tool, opts)) continue;
    const permission = clampPermission(tool, value);
    if (permission !== "deny") out[key] = permission;
  }
  return out;
}
