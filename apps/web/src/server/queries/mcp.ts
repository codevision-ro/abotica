import "server-only";
import {
  BUILTIN_MCP_SERVERS,
  builtinMcp,
  builtinMcpKeyStatus,
  redactStoredValue,
  type StoredValue,
  unsealValue,
} from "@abotica/core";
import { agentMcpServers, db, mcpOAuth, mcpServers, projectMcpServers, secrets } from "@abotica/db";
import { asc, count, eq } from "@abotica/db/orm";
import { query } from "@/server/query";

export type McpOAuthStatus = {
  state: "connected" | "disconnected" | "error";
  connectedAt: Date | null;
  expiresAt: Date | null;
  scope: string | null;
  /** Why a run or test found the authorization expired or revoked; cleared by a new Connect. */
  error: string | null;
};

type OAuthRow = Pick<typeof mcpOAuth.$inferSelect, "tokens" | "connectedAt" | "expiresAt" | "scope" | "lastError">;

/** Never exposes the encrypted credentials, only whether they exist. */
function oauthStatus(row: OAuthRow | undefined): McpOAuthStatus {
  // A revoked authorization also drops the tokens, so the error wins over their absence.
  const state = row?.lastError ? "error" : row?.tokens ? "connected" : "disconnected";
  return {
    state,
    connectedAt: row?.connectedAt ?? null,
    expiresAt: row?.expiresAt ?? null,
    scope: row?.scope ?? null,
    error: row?.lastError ?? null,
  };
}

const oauthColumns = {
  serverId: mcpOAuth.serverId,
  tokens: mcpOAuth.tokens,
  connectedAt: mcpOAuth.connectedAt,
  expiresAt: mcpOAuth.expiresAt,
  scope: mcpOAuth.scope,
  lastError: mcpOAuth.lastError,
};

/** What the list shows; env, headers and OAuth client settings stay on the server. */
const listColumns = {
  id: mcpServers.id,
  slug: mcpServers.slug,
  name: mcpServers.name,
  transport: mcpServers.transport,
  url: mcpServers.url,
  command: mcpServers.command,
  args: mcpServers.args,
  auth: mcpServers.auth,
  enabled: mcpServers.enabled,
  global: mcpServers.global,
  builtin: mcpServers.builtin,
  tools: mcpServers.tools,
};

async function listMcpServers() {
  const [rows, agentCounts, projectCounts, oauthRows, keys] = await Promise.all([
    db.select(listColumns).from(mcpServers).orderBy(asc(mcpServers.name)),
    db.select({ id: agentMcpServers.mcpServerId, n: count() }).from(agentMcpServers).groupBy(agentMcpServers.mcpServerId),
    db
      .select({ id: projectMcpServers.mcpServerId, n: count() })
      .from(projectMcpServers)
      .groupBy(projectMcpServers.mcpServerId),
    db.select(oauthColumns).from(mcpOAuth),
    builtinMcpKeyStatus(),
  ]);
  const a = new Map(agentCounts.map((r) => [r.id, r.n]));
  const p = new Map(projectCounts.map((r) => [r.id, r.n]));
  const o = new Map(oauthRows.map((r) => [r.serverId, r]));
  return rows.map(({ tools, ...s }) => ({
    ...s,
    toolCount: tools?.length ?? null,
    agentCount: a.get(s.id) ?? 0,
    projectCount: p.get(s.id) ?? 0,
    oauth: isOAuth(s) ? oauthStatus(o.get(s.id)).state : null,
    apiKey: apiKeyStatus(s.builtin, keys),
  }));
}

/** The servers split for the list page: the bundled ones in catalog order, then the user's. */
export const listMcpServerGroups = query(async () => {
  const servers = await listMcpServers();
  const order = (s: McpListItem) => BUILTIN_MCP_SERVERS.findIndex((b) => b.key === s.builtin);
  return {
    builtin: servers.filter((s) => builtinMcp(s.builtin)).sort((x, y) => order(x) - order(y)),
    user: servers.filter((s) => !s.builtin),
  };
});

/** Whether a bundled HTTP server's optional API key is stored; null for every other server. */
function apiKeyStatus(builtin: string | null, keys: Record<string, boolean>): boolean | null {
  const bundled = builtinMcp(builtin);
  return bundled?.transport === "http" ? (keys[bundled.apiKeySecret] ?? false) : null;
}

const isOAuth = (s: Pick<typeof mcpServers.$inferSelect, "transport" | "auth">) =>
  s.transport === "http" && s.auth === "oauth";

export type McpListItem = Awaited<ReturnType<typeof listMcpServers>>[number];

/**
 * A saved value as the form gets it. Opened only to decide whether it may be shown; one the vault
 * cannot open (VAULT_KEY changed) is hidden like a secret, so the form still loads and the user can
 * type it again.
 */
function redactSaved(value: string): StoredValue {
  try {
    return redactStoredValue(unsealValue(value));
  } catch {
    return null;
  }
}

const redactSavedRecord = (record: Record<string, string>) =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, redactSaved(value)]));

/** The stored row, credentials sealed; for server actions, never for a client component. */
export const getMcpServer = query(async (id: string) => {
  const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
  return server ?? null;
});

/**
 * The server with its assignments and OAuth status, for the edit form. Saved env and header values,
 * credential route values and the OAuth client secret are write-only: the form gets them only when
 * they reference the vault.
 */
export const getMcpServerDetail = query(async (id: string) => {
  const server = await getMcpServer(id);
  if (!server) return null;
  const [agentIds, projectIds, [oauth], keys] = await Promise.all([
    db.select({ id: agentMcpServers.agentId }).from(agentMcpServers).where(eq(agentMcpServers.mcpServerId, id)),
    db.select({ id: projectMcpServers.projectId }).from(projectMcpServers).where(eq(projectMcpServers.mcpServerId, id)),
    db.select(oauthColumns).from(mcpOAuth).where(eq(mcpOAuth.serverId, id)),
    server.builtin ? builtinMcpKeyStatus() : {},
  ]);
  const { env, headers, credentialRoutes, oauthClientSecret, ...rest } = server;
  return {
    ...rest,
    env: redactSavedRecord(env),
    headers: redactSavedRecord(headers),
    credentialRoutes: credentialRoutes.map((route) => ({ ...route, value: redactSaved(route.value) })),
    oauthClientSecret: oauthClientSecret === null ? null : redactSaved(oauthClientSecret),
    /** A saved client secret, shown or not. */
    hasOAuthClientSecret: oauthClientSecret !== null,
    agentIds: agentIds.map((r) => r.id),
    projectIds: projectIds.map((r) => r.id),
    oauth: isOAuth(server) ? oauthStatus(oauth) : null,
    apiKey: apiKeyStatus(server.builtin, keys),
  };
});

export const listSecretNames = query(async (): Promise<string[]> => {
  const rows = await db.select({ name: secrets.name }).from(secrets).orderBy(asc(secrets.name));
  return rows.map((r) => r.name);
});
