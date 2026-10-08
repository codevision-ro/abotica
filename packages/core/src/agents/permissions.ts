/** Tool permission rules. Pure and client-safe: no database or server imports. */
import type { ToolPermission, ToolPermissions } from "@abotica/db";
import { builtinMcp } from "../mcp/mcp-builtins";
import { TOOL_CATALOG, type ToolInfo } from "./tools/tool-catalog";

export type { ToolPermission, ToolPermissions };

/** Display order: least to most restrictive. */
export const TOOL_PERMISSIONS = ["allow", "ask", "deny"] as const satisfies readonly ToolPermission[];

/**
 * Starting permission of an MCP tool whose hints do not mark it safe: it declares none, declares itself
 * destructive, or is not known yet (its server's tools were never loaded).
 */
export const MCP_DEFAULT_PERMISSION: ToolPermission = "ask";
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
 * Starting permission of an MCP tool from its hints: allow when it only reads or only adds, else
 * MCP_DEFAULT_PERMISSION. Hints come from the server and are not trusted: they only pick the value a
 * tool starts at, and the most a server can claim is allow, what every MCP tool started at before.
 */
export function annotationPermission(annotations?: Record<string, unknown>): ToolPermission {
  const hint = mcpToolHint(annotations);
  return hint === "readOnly" || hint === "nonDestructive" ? "allow" : MCP_DEFAULT_PERMISSION;
}

/**
 * What an MCP tool starts at without an entry the user set: the choice Abotica makes for a bundled
 * server it ships (mcp-builtins.ts), else the default from the tool's hints.
 */
export function mcpToolDefault(annotations: Record<string, unknown> | undefined, builtin?: string | null): ToolPermission {
  return builtinMcp(builtin)?.defaultPermission ?? annotationPermission(annotations);
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
