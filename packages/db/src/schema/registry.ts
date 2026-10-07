import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./_shared";
import { agents } from "./agents";
import { mcpAuth, mcpTransport, mcpWorkspace } from "./enums";
import { type NetworkPolicy, projects } from "./projects";

/**
 * Where an installed skill came from; null for skills written or imported by hand.
 * `hash` identifies the upstream content of the last install or update (compared to detect updates);
 * `contentHash` is the hash of the stored skill right after it, so a different hash means local edits.
 */
export type SkillOrigin = (
  { kind: "skills.sh"; id: string } | { kind: "github"; repo: string; ref: string; path: string }
) & { url: string; hash: string };

export type SkillSource = SkillOrigin & { contentHash: string };

/**
 * A skill in the Agent Skills format: a folder with SKILL.md and optional supporting files.
 * Name, description and the other frontmatter fields live in columns; the SKILL.md file holds the body.
 */
export const skills = pgTable("skills", {
  id: id(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  description: text().notNull().default(""),
  /** Frontmatter fields other than name and description (license, allowed-tools...), kept for export. */
  metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean().notNull().default(true),
  version: integer().notNull().default(1),
  source: jsonb().$type<SkillSource>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** The files of a skill, by path relative to the skill folder ("SKILL.md", "references/api.md"). */
export const skillFiles = pgTable(
  "skill_files",
  {
    skillId: uuid()
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    path: text().notNull(),
    content: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.skillId, t.path] })],
);

export type SkillFile = { path: string; content: string };

export type SkillSnapshot = { name: string; description: string; metadata: Record<string, unknown>; files: SkillFile[] };

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: id(),
    skillId: uuid()
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    snapshot: jsonb().$type<SkillSnapshot>().notNull(),
    note: text().notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.skillId, t.version)],
);

/**
 * A tool an MCP server exposed the last time Abotica connected to it. The definition fields let a
 * run offer the tool without connecting first; rows cached before they existed have only the name
 * and description, and the run connects up front for those.
 */
export type McpToolInfo = {
  name: string;
  description: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export const mcpServers = pgTable("mcp_servers", {
  id: id(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  transport: mcpTransport().notNull(),
  url: text(),
  command: text(),
  args: jsonb().$type<string[]>().notNull().default([]),
  /** Values may reference vault secrets as `{{secret:NAME}}`. */
  env: jsonb().$type<Record<string, string>>().notNull().default({}),
  headers: jsonb().$type<Record<string, string>>().notNull().default({}),
  /** Network access of a stdio server's sandboxed process; unused for http servers. */
  network: jsonb().$type<NetworkPolicy>().notNull().default({ mode: "full", domains: [] }),
  /**
   * Stdio servers run in the sandbox. False runs the process directly in the worker, with the worker
   * user's files: only for trusted servers that need host state (a browser in ~/.cache, local configs).
   */
  sandboxed: boolean().notNull().default(true),
  /** Stdio servers: `run` starts the process in the workspace of the run that uses it. */
  workspace: mcpWorkspace().notNull().default("server"),
  /** Offered to every agent; an agent opts out by denying the server in its permissions. */
  global: boolean().notNull().default(false),
  /** Key of the bundled server this row is (`mcp-builtins.ts`); null for servers added by the user. */
  builtin: text().unique(),
  auth: mcpAuth().notNull().default("headers"),
  /** Pre-registered OAuth client; null means dynamic client registration. */
  oauthClientId: text(),
  /** May reference a vault secret as `{{secret:NAME}}`. */
  oauthClientSecret: text(),
  oauthScope: text(),
  /** Tools seen on the last successful connection (test or run); null until the first one. */
  tools: jsonb().$type<McpToolInfo[]>(),
  toolsSyncedAt: timestamp({ withTimezone: true }),
  enabled: boolean().notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** The authorization server that issued an MCP server's OAuth credentials, pinned to detect a swap. */
export type McpOAuthServerInfo = { issuer?: string; authorizationServerUrl: string; tokenEndpoint: string };

/** OAuth state of an MCP server. Credentials are encrypted with the vault key. */
export const mcpOAuth = pgTable("mcp_oauth", {
  serverId: uuid()
    .primaryKey()
    .references(() => mcpServers.id, { onDelete: "cascade" }),
  /** Client from dynamic registration (JSON, encrypted). */
  client: text(),
  /** Access and refresh tokens (JSON, encrypted). */
  tokens: text(),
  authServer: jsonb().$type<McpOAuthServerInfo>(),
  /** Pending authorization: the PKCE verifier (encrypted) and the state the callback is matched by. */
  codeVerifier: text(),
  state: text().unique(),
  startedAt: timestamp({ withTimezone: true }),
  /** Callback URL of the pending authorization; the code exchange must repeat it. */
  redirectUri: text(),
  connectedAt: timestamp({ withTimezone: true }),
  expiresAt: timestamp({ withTimezone: true }),
  scope: text(),
  /** Why the last connection needed a new authorization; cleared when it succeeds. */
  lastError: text(),
  updatedAt: updatedAt(),
});

export const agentSkills = pgTable(
  "agent_skills",
  {
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillId: uuid()
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.skillId] })],
);

export const agentMcpServers = pgTable(
  "agent_mcp_servers",
  {
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    mcpServerId: uuid()
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.mcpServerId] })],
);

export const projectSkills = pgTable(
  "project_skills",
  {
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    skillId: uuid()
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.skillId] })],
);

export const projectMcpServers = pgTable(
  "project_mcp_servers",
  {
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    mcpServerId: uuid()
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.mcpServerId] })],
);
