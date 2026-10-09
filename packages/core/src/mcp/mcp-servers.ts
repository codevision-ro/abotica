/**
 * The MCP server registry: saving servers with their assignments, the bundled servers' rules,
 * keeping their rows in line with the catalog, and the registry's connection test. Server only.
 *
 * Env and header values, credential route values and the OAuth client secret are stored sealed (vault.ts `sealValue`);
 * `interpolateSecrets` opens them where a connection uses them, and values saved before that are
 * read as plain text until `encryptLegacyMcpCredentials` rewrites them.
 */
import {
  agentMcpServers,
  db,
  type McpCredentialRoute,
  mcpOAuth,
  mcpServers,
  type NetworkPolicy,
  projectMcpServers,
  secrets,
} from "@abotica/db";
import { eq, inArray, isNotNull } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { isRouteHeader, isRouteUpstream } from "@abotica/sandbox/routes";
import type { MCPClient } from "@ai-sdk/mcp";
import {
  connectHttpMcp,
  type McpConnectOptions,
  type McpTestResult,
  onMcpServerDeleted,
  probeMcp,
  testMcpServer,
} from "../agents/mcp";
import { MCP_OAUTH_REQUIRED } from "../agents/mcp-oauth";
import { mcpRouteId } from "../agents/mcp-routes";
import { audit } from "../platform/audit";
import { BUILTIN_MCP_SERVERS, type BuiltinMcp, builtinMcp } from "./mcp-builtins";
import { type KeepStored, MCP_TIMEOUTS, resolveStoredRecord, resolveStoredSecret } from "./mcp-stored-values";
import { DEFAULT_MCP_NETWORK, parseNetworkPolicy } from "../sandbox/sandbox-policy";
import { OWNER_SECRETS, sealValue, unsealValue } from "../platform/vault";

type McpRow = typeof mcpServers.$inferSelect;
type McpCredentials = Pick<McpRow, "env" | "headers" | "credentialRoutes" | "oauthClientSecret">;

/** The connection settings of a server, as the registry form sends them (normalized). */
export type McpServerValues = {
  name: string;
  slug: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
  auth: "headers" | "oauth";
  oauthClientId: string | null;
  oauthClientSecret: string | null;
  oauthScope: string | null;
  network: NetworkPolicy;
  sandboxed: boolean;
  workspace: "server" | "run";
  credentialRoutes: McpCredentialRoute[];
  /** Seconds; null uses the default (MCP_TIMEOUTS). */
  connectTimeoutSec: number | null;
  callTimeoutSec: number | null;
};

/** A credential route as the form sends it; a value it could not show comes back as `{ keep: <saved baseUrlEnv> }`. */
export type McpCredentialRouteDraft = Omit<McpCredentialRoute, "value" | "keyEnv"> & {
  value: string | KeepStored;
  keyEnv?: string | null;
};

/** The registry form as validated, before `normalizeMcpServerValues`. */
export type McpServerDraft = {
  name: string;
  slug: string;
  transport: "http" | "stdio";
  url?: string | null;
  command?: string | null;
  args: string[];
  /** A value the form could not show comes back as `{ keep: <its saved key> }`. */
  env: Record<string, string | KeepStored>;
  headers: Record<string, string | KeepStored>;
  auth: "headers" | "oauth";
  oauthClientId?: string | null;
  oauthClientSecret?: string | { keep: true } | null;
  oauthScope?: string | null;
  /** Stdio only, checked by `parseNetworkPolicy`. */
  network?: unknown;
  sandboxed: boolean;
  workspace: "server" | "run";
  /** Sandboxed stdio only, checked by `normalizeCredentialRoutes`. */
  credentialRoutes?: McpCredentialRouteDraft[];
  /** Within MCP_TIMEOUTS; null or missing uses the default. */
  connectTimeoutSec?: number | null;
  callTimeoutSec?: number | null;
};

/** An environment variable a route may set; it also names the route (`mcpRouteId`). */
const ENV_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The credential routes to save, checked with the rules the sandbox applies when it runs them, so a
 * mistake shows up in the form and not in a run. Kept values come from `saved`.
 */
export function normalizeCredentialRoutes(
  drafts: McpCredentialRouteDraft[],
  saved: McpCredentialRoute[] | null,
): McpCredentialRoute[] {
  const savedValues = saved && Object.fromEntries(saved.map((route) => [route.baseUrlEnv, route.value]));
  const ids = new Set<string>();
  return drafts.map((draft) => {
    const baseUrlEnv = draft.baseUrlEnv.trim();
    const keyEnv = draft.keyEnv?.trim() || undefined;
    const upstream = draft.upstream.trim();
    const header = draft.header.trim();
    for (const name of [baseUrlEnv, keyEnv]) {
      if (name !== undefined && !ENV_NAME_RE.test(name)) throw new UserError("mcp.errors.routeEnvName", { name });
    }
    const id = mcpRouteId({ baseUrlEnv });
    if (ids.has(id)) throw new UserError("mcp.errors.routeDuplicate", { name: baseUrlEnv });
    ids.add(id);
    if (!isRouteUpstream(upstream)) throw new UserError("mcp.errors.routeUpstream", { name: baseUrlEnv });
    const value = resolveStoredRecord({ [baseUrlEnv]: draft.value }, savedValues)[baseUrlEnv]!;
    if (!value.trim()) throw new UserError("mcp.errors.routeValueRequired", { name: baseUrlEnv });
    if (!isRouteHeader(header, value)) throw new UserError("mcp.errors.routeHeader", { name: baseUrlEnv });
    return { baseUrlEnv, upstream, header, value, ...(keyEnv && { keyEnv }) };
  });
}

/**
 * Keeps only the fields that belong to the chosen transport and authentication; values the form
 * kept as saved come from `saved` (the row being edited, null for a new server).
 */
export function normalizeMcpServerValues(v: McpServerDraft, saved: McpCredentials | null): McpServerValues {
  const http = v.transport === "http";
  const sandboxed = http || v.sandboxed;
  const oauth = http && v.auth === "oauth";
  const clientId = oauth ? v.oauthClientId || null : null;
  return {
    name: v.name,
    slug: v.slug,
    transport: v.transport,
    url: http ? (v.url ?? null) : null,
    command: http ? null : (v.command ?? null),
    args: http ? [] : v.args.map((a) => a.trim()).filter(Boolean),
    env: http ? {} : resolveStoredRecord(v.env, saved?.env ?? null),
    headers: http ? resolveStoredRecord(v.headers, saved?.headers ?? null) : {},
    auth: oauth ? "oauth" : "headers",
    oauthClientId: clientId,
    // A secret without its client id is meaningless.
    oauthClientSecret: clientId ? resolveStoredSecret(v.oauthClientSecret || null, saved?.oauthClientSecret ?? null) : null,
    oauthScope: oauth ? v.oauthScope || null : null,
    network: http ? DEFAULT_MCP_NETWORK : parseNetworkPolicy(v.network ?? DEFAULT_MCP_NETWORK),
    sandboxed,
    // Only a sandboxed stdio process can live in a run's workspace or use the egress proxy's routes.
    workspace: !http && sandboxed ? v.workspace : "server",
    credentialRoutes:
      !http && sandboxed ? normalizeCredentialRoutes(v.credentialRoutes ?? [], saved?.credentialRoutes ?? null) : [],
    connectTimeoutSec: timeoutSec(v.connectTimeoutSec, MCP_TIMEOUTS.connectSec, "mcp.validation.connectTimeout"),
    callTimeoutSec: timeoutSec(v.callTimeoutSec, MCP_TIMEOUTS.callSec, "mcp.validation.callTimeout"),
  };
}

/** A timeout of the form: whole seconds within its bounds, or null for the default. */
function timeoutSec(value: number | null | undefined, bounds: { min: number; max: number }, key: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new UserError(key, { min: bounds.min, max: bounds.max });
  }
  return value;
}

const mapValues = (record: Record<string, string>, fn: (value: string) => string) =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value)]));

const mapRouteValues = (routes: McpCredentialRoute[], fn: (value: string) => string) =>
  routes.map((route) => ({ ...route, value: fn(route.value) }));

/** The credentials as they are stored: sealed, values that already are stay as they are. */
export function sealMcpCredentials<T extends McpCredentials>(values: T): T {
  return {
    ...values,
    env: mapValues(values.env, sealValue),
    headers: mapValues(values.headers, sealValue),
    credentialRoutes: mapRouteValues(values.credentialRoutes, sealValue),
    oauthClientSecret: values.oauthClientSecret === null ? null : sealValue(values.oauthClientSecret),
  };
}

/** The credentials in plain text, for server code only: a client component never gets them. */
export function openMcpCredentials<T extends McpCredentials>(row: T): T {
  return {
    ...row,
    env: mapValues(row.env, unsealValue),
    headers: mapValues(row.headers, unsealValue),
    credentialRoutes: mapRouteValues(row.credentialRoutes, unsealValue),
    oauthClientSecret: row.oauthClientSecret === null ? null : unsealValue(row.oauthClientSecret),
  };
}

export type SaveMcpServerInput = {
  /** Ignored for a bundled server: its connection follows the catalog. */
  values: McpServerValues;
  enabled: boolean;
  global: boolean;
  agentIds: string[];
  projectIds: string[];
};

/** OAuth credentials belong to one server URL and client configuration; any change invalidates them. */
const OAUTH_BINDING = ["transport", "url", "auth", "oauthClientId", "oauthClientSecret", "oauthScope"] as const;

export const mcpOAuthBindingChanged = (
  before: Pick<McpRow, (typeof OAUTH_BINDING)[number]>,
  after: Pick<McpServerValues, (typeof OAUTH_BINDING)[number]>,
) =>
  OAUTH_BINDING.some((key) =>
    // The same secret sealed twice differs as text.
    key === "oauthClientSecret" ? openSecret(before[key]) !== openSecret(after[key]) : before[key] !== after[key],
  );

const openSecret = (value: string | null) => (value === null ? null : unsealValue(value));

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/** The row values a bundled server must have; everything the user cannot change. */
function builtinValues(b: BuiltinMcp): McpServerValues {
  const http = b.transport === "http";
  return {
    name: b.name,
    slug: b.slug,
    transport: b.transport,
    url: http ? b.url : null,
    command: http ? null : b.command,
    args: http ? [] : b.args,
    env: {},
    // The API key is added when connecting, only if the user set it.
    headers: {},
    auth: "headers",
    oauthClientId: null,
    oauthClientSecret: null,
    oauthScope: null,
    network: http ? { mode: "full", domains: [] } : b.network,
    sandboxed: true,
    workspace: http ? "server" : "run",
    credentialRoutes: [],
    connectTimeoutSec: null,
    callTimeoutSec: null,
  };
}

/** Inserts (no id) or updates a server and replaces its assignments; returns its id. */
export async function saveMcpServer(id: string | undefined, input: SaveMcpServerInput): Promise<string> {
  const { enabled, global, agentIds, projectIds } = input;
  let values = input.values;
  try {
    const serverId = await db.transaction(async (tx) => {
      let serverId = id;
      if (serverId) {
        const [before] = await tx.select().from(mcpServers).where(eq(mcpServers.id, serverId)).for("update");
        if (!before) throw new UserError("mcp.errors.notFound");
        const bundled = builtinMcp(before.builtin);
        if (bundled) values = builtinValues(bundled);
        await tx
          .update(mcpServers)
          .set({ ...sealMcpCredentials(values), enabled, global })
          .where(eq(mcpServers.id, serverId));
        if (mcpOAuthBindingChanged(before, values)) await tx.delete(mcpOAuth).where(eq(mcpOAuth.serverId, serverId));
      } else {
        const [row] = await tx
          .insert(mcpServers)
          .values({ ...sealMcpCredentials(values), enabled, global })
          .returning({ id: mcpServers.id });
        serverId = row!.id;
      }
      await tx.delete(agentMcpServers).where(eq(agentMcpServers.mcpServerId, serverId));
      await tx.delete(projectMcpServers).where(eq(projectMcpServers.mcpServerId, serverId));
      if (agentIds.length) {
        await tx.insert(agentMcpServers).values(agentIds.map((agentId) => ({ agentId, mcpServerId: serverId! })));
      }
      if (projectIds.length) {
        await tx.insert(projectMcpServers).values(projectIds.map((projectId) => ({ projectId, mcpServerId: serverId! })));
      }
      return serverId;
    });
    await audit({
      actor: "user",
      action: id ? "mcp.updated" : "mcp.created",
      entityType: "mcp_server",
      entityId: serverId,
      data: {
        slug: values.slug,
        transport: values.transport,
        auth: values.auth,
        global,
        ...(values.transport === "stdio" && {
          sandboxed: values.sandboxed,
          network: values.network.mode,
          workspace: values.workspace,
          credentialRoutes: values.credentialRoutes.length,
        }),
        ...(values.connectTimeoutSec !== null && { connectTimeoutSec: values.connectTimeoutSec }),
        ...(values.callTimeoutSec !== null && { callTimeoutSec: values.callTimeoutSec }),
        agents: agentIds.length,
        projects: projectIds.length,
      },
    });
    return serverId;
  } catch (error) {
    if (isUniqueViolation(error)) throw new UserError("mcp.errors.slugTaken", { slug: values.slug });
    throw error;
  }
}

export async function setMcpServerEnabled(id: string, enabled: boolean): Promise<void> {
  const [row] = await db.update(mcpServers).set({ enabled }).where(eq(mcpServers.id, id)).returning({ id: mcpServers.id });
  if (!row) throw new UserError("mcp.errors.notFound");
  await audit({ actor: "user", action: enabled ? "mcp.enabled" : "mcp.disabled", entityType: "mcp_server", entityId: id });
}

/** A global server is offered to every agent; one that is not reaches only its assigned agents and projects. */
export async function setMcpServerGlobal(id: string, global: boolean): Promise<void> {
  const [row] = await db.update(mcpServers).set({ global }).where(eq(mcpServers.id, id)).returning({ id: mcpServers.id });
  if (!row) throw new UserError("mcp.errors.notFound");
  await audit({
    actor: "user",
    action: global ? "mcp.made-global" : "mcp.made-local",
    entityType: "mcp_server",
    entityId: id,
  });
}

/** Bundled servers cannot be deleted, only disabled. */
export async function deleteMcpServer(id: string): Promise<void> {
  const [row] = await db
    .select({ slug: mcpServers.slug, builtin: mcpServers.builtin })
    .from(mcpServers)
    .where(eq(mcpServers.id, id));
  if (!row) return;
  if (row.builtin) throw new UserError("mcp.errors.builtinDelete");
  await db.delete(mcpServers).where(eq(mcpServers.id, id));
  await audit({ actor: "user", action: "mcp.deleted", entityType: "mcp_server", entityId: id, data: { slug: row.slug } });
  // Removes the server's sandbox workspace with its package cache.
  await onMcpServerDeleted(row.slug);
}

/** Whether the user stored the optional API key of a bundled server, without reading it. */
export async function builtinMcpKeyStatus(): Promise<Record<string, boolean>> {
  const names = BUILTIN_MCP_SERVERS.flatMap((b) => (b.transport === "http" ? [b.apiKeySecret] : []));
  const rows = await db.select({ name: secrets.name }).from(secrets).where(inArray(secrets.name, names));
  const stored = new Set(rows.map((r) => r.name));
  return Object.fromEntries(names.map((n) => [n, stored.has(n)]));
}

const sameValues = (row: McpRow, values: McpServerValues) =>
  (Object.keys(values) as (keyof McpServerValues)[]).every(
    (key) => JSON.stringify(row[key]) === JSON.stringify(values[key]),
  );

/**
 * Creates the bundled servers that are missing (enabled and global) and brings the existing ones'
 * connection settings in line with the catalog; the user's choices (enabled, global, assignments,
 * permissions) stay. A server the user added under a bundled slug keeps it, and that bundled
 * server is left out. Returns the bundled rows, for the worker to fill their tool caches.
 */
export async function syncBuiltinMcpServers(): Promise<McpRow[]> {
  const rows = await db.select().from(mcpServers).where(isNotNull(mcpServers.builtin));
  for (const bundled of BUILTIN_MCP_SERVERS) {
    const values = builtinValues(bundled);
    const row = rows.find((r) => r.builtin === bundled.key);
    if (!row) {
      const inserted = await db
        .insert(mcpServers)
        .values({ ...values, builtin: bundled.key, enabled: true, global: true })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) rows.push(inserted[0]);
      else console.warn(`[mcp] "${bundled.slug}" is taken by a server added by the user; the bundled one is skipped`);
      continue;
    }
    if (sameValues(row, values)) continue;
    // New connection settings: the cached tools may no longer match.
    const [updated] = await db
      .update(mcpServers)
      .set({ ...values, tools: null, toolsSyncedAt: null })
      .where(eq(mcpServers.id, row.id))
      .returning();
    rows.splice(rows.indexOf(row), 1, updated!);
  }
  // Rows of bundled servers that left the catalog are removed with their workspaces.
  const known = new Set<string>(BUILTIN_MCP_SERVERS.map((b) => b.key));
  for (const row of rows.filter((r) => !known.has(r.builtin!))) {
    await db.delete(mcpServers).where(eq(mcpServers.id, row.id));
    await onMcpServerDeleted(row.slug);
  }
  return rows.filter((r) => known.has(r.builtin!));
}

/**
 * Seals the credentials of servers saved while they were stored as plain text. Idempotent; the
 * worker runs it at start. Returns how many servers it rewrote.
 */
export async function encryptLegacyMcpCredentials(): Promise<number> {
  const count = await db.transaction(async (tx) => {
    // Locked, so a server saved meanwhile is not overwritten with its old values.
    const rows = await tx
      .select({
        id: mcpServers.id,
        env: mcpServers.env,
        headers: mcpServers.headers,
        credentialRoutes: mcpServers.credentialRoutes,
        oauthClientSecret: mcpServers.oauthClientSecret,
      })
      .from(mcpServers)
      .for("update");
    let rewritten = 0;
    for (const row of rows) {
      const sealed = sealMcpCredentials(row);
      if (JSON.stringify(sealed) === JSON.stringify(row)) continue;
      const { id, ...credentials } = sealed;
      await tx.update(mcpServers).set(credentials).where(eq(mcpServers.id, id));
      rewritten++;
    }
    return rewritten;
  });
  if (count > 0) console.log(`[mcp] encrypted the stored credentials of ${count} server(s)`);
  return count;
}

/** A failure whose own message says nothing to the user, for the caller to explain in their language. */
export type McpTestFailure = "timeout" | "fetchFailed" | "processClosed" | "oauthRequired";

export type McpConnectionTest = McpTestResult & { failure?: McpTestFailure };

/** Messages of fetch and the MCP SDK that stand for a known failure. */
export function mcpTestFailure(message: string | undefined): McpTestFailure | undefined {
  if (message === "fetch failed") return "fetchFailed";
  if (message === "Attempted to send a request from a closed client") return "processClosed";
  if (message === MCP_OAUTH_REQUIRED || message === "Unauthorized") return "oauthRequired";
  return undefined;
}

/** connectHttpMcp whose client is closed when `signal` aborts, also when it connects only after that. */
const abortableHttpConnect =
  (signal: AbortSignal) =>
  async (server: McpRow, opts: McpConnectOptions): Promise<MCPClient> => {
    const client = await connectHttpMcp(server, opts);
    const close = () => void client.close().catch(() => {});
    if (signal.aborted) {
      close();
      throw new Error("The test was abandoned");
    }
    signal.addEventListener("abort", close, { once: true });
    return client;
  };

/**
 * The registry's Test and Sync tools: connects once with the user's secrets and lists the tools,
 * giving up after `timeoutMs`. An http connection is closed then; a stdio test runs in the worker,
 * which gives up by the same deadline. Credentials are sealed first, so the worker's job data holds no
 * plain values, also for a draft that was never saved.
 */
export async function testMcpServerConnection(server: McpRow, timeoutMs: number): Promise<McpConnectionTest> {
  const sealed = sealMcpCredentials(server);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timedOut = new Promise<McpConnectionTest>((resolve) =>
    controller.signal.addEventListener("abort", () => resolve({ ok: false, tools: [], failure: "timeout" }), {
      once: true,
    }),
  );
  try {
    const test =
      sealed.transport === "stdio"
        ? testMcpServer(sealed, timeoutMs)
        : probeMcp(sealed, OWNER_SECRETS, abortableHttpConnect(controller.signal), timeoutMs);
    const result: McpConnectionTest = await Promise.race([
      test.catch((error: unknown): McpConnectionTest => ({
        ok: false,
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      })),
      timedOut,
    ]);
    const failure = result.failure ?? mcpTestFailure(result.error);
    return failure ? { ...result, failure } : result;
  } finally {
    clearTimeout(timer);
  }
}
