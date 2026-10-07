import { createHash } from "node:crypto";
import type { SecretScope } from "../platform/vault";

/**
 * Workspace keys: which project, conversation or MCP server a sandbox workspace belongs to.
 * Pure, so the reaper's mapping is testable without a database. An MCP server's keys depend on its
 * secret scope as well (agents/mcp.ts mcpWorkspaceKeyFor), so the reaper matches them whole.
 */

export const projectWorkspaceKey = (projectId: string) => `project-${projectId}`;
export const conversationWorkspaceKey = (conversationId: string) => `conversation-${conversationId}`;

/**
 * The own workspace of a stdio MCP server for one secret scope, so processes holding one project's
 * secrets never share a container with another project's, or with the user's tests (every secret).
 * The hash keeps the key within 63 characters for any slug; the slug prefix keeps it readable.
 * Keys of the older form `mcp-<slug>` belong to no scope and are removed by the reaper.
 */
export function mcpWorkspaceKeyFor(slug: string, scope: SecretScope): string {
  const tag = "owner" in scope ? "owner" : scope.projectId === null ? "global" : `project:${scope.projectId}`;
  const hash = createHash("sha256").update(`${slug}\n${tag}`).digest("hex").slice(0, 24);
  return `mcp-${slug.slice(0, 24).replace(/-+$/, "")}-${hash}`;
}

export type WorkspaceOwner = { kind: "project"; id: string } | { kind: "conversation"; id: string } | { kind: "mcp" };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PROJECT_RE = new RegExp(`^project-(${UUID})$`);
const CONVERSATION_RE = new RegExp(`^conversation-(${UUID})$`);
const MCP_RE = /^mcp-[a-z0-9-]+$/;

/** The owner of a workspace key, or null for keys Abotica did not create (e.g. a backend's probe). */
export function workspaceOwner(key: string): WorkspaceOwner | null {
  const project = PROJECT_RE.exec(key);
  if (project) return { kind: "project", id: project[1]! };
  const conversation = CONVERSATION_RE.exec(key);
  if (conversation) return { kind: "conversation", id: conversation[1]! };
  return MCP_RE.test(key) ? { kind: "mcp" } : null;
}
