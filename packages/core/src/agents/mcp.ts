/**
 * MCP pieces any process may use: http connections, the tool cache and the registry test. Stdio
 * servers run only in the worker (`mcp-runtime.ts`), so their tests are sent there as jobs.
 */
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { db, mcpServers, type McpToolInfo, projects } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { getTranslator, isUserError, translateKey, UserError } from "@abotica/i18n";
import { sandboxQueue, sandboxQueueEvents } from "../infra/queues";
import { requestWorkspaceRemoval } from "../sandbox/sandbox";
import { mcpWorkspaceKeyFor } from "../sandbox/sandbox-keys";
import { builtinMcp } from "../mcp/mcp-builtins";
import { getSettings, settingsLocale } from "../settings/settings";
import {
  GLOBAL_SECRETS,
  OWNER_SECRETS,
  resolveSecret,
  resolveSecretPlaceholders,
  type SecretScope,
} from "../platform/vault";
import type { McpServer } from "./context";
import { markMcpOAuthError, mcpRuntimeAuthProvider } from "./mcp-oauth";
import { secretRedactor } from "./redact";

/** Where a runtime MCP tool comes from, kept because the `<slug>__<tool>` name cannot be reversed safely. */
export type McpToolSource = { serverSlug: string; tool: string };

export type McpTestResult = { ok: boolean; tools: McpToolInfo[]; error?: string };

export type McpConnectOptions = {
  /** Aborting stops a stdio server's process (run cancelled, test timed out). */
  signal?: AbortSignal;
  /** The secrets the server's placeholders, API key and OAuth client may use: the run's project, or the user's. */
  secrets: SecretScope;
  /** Gets the secret values the connection resolved, so what the server sends back can be redacted. */
  onSecrets?: (secrets: string[]) => void;
};

/** Longest a registry test waits for the worker; the worker gives up a little earlier. */
const MCP_TEST_TIMEOUT_MS = 60_000;
const MCP_PROBE_TIMEOUT_MS = 50_000;

/** `record` with its secret placeholders filled in, the values used reported to `onSecrets`. */
export async function resolveMcpSecrets(
  record: Record<string, string>,
  opts: McpConnectOptions,
): Promise<Record<string, string>> {
  const { values, secrets } = await resolveSecretPlaceholders(record, opts.secrets);
  opts.onSecrets?.(secrets);
  return values;
}

/** The server's headers with secrets filled in; a bundled server gets its API key when the user set one. */
async function httpHeaders(server: McpServer, opts: McpConnectOptions): Promise<Record<string, string>> {
  const headers = await resolveMcpSecrets(server.headers, opts);
  const bundled = builtinMcp(server.builtin);
  if (bundled?.transport === "http") {
    const key = await resolveSecret(bundled.apiKeySecret, opts.secrets);
    if (key) {
      opts.onSecrets?.([key]);
      headers.Authorization = `Bearer ${key}`;
    }
  }
  return headers;
}

/** Connects to an http server; works in any process. */
export async function connectHttpMcp(server: McpServer, opts: McpConnectOptions): Promise<MCPClient> {
  if (!server.url) throw new Error(`MCP ${server.slug}: url is missing`);
  // Throws before connecting when the server was never authorized.
  const authProvider = server.auth === "oauth" ? await mcpRuntimeAuthProvider(server, opts.secrets) : undefined;
  try {
    return await createMCPClient({
      transport: {
        type: "http",
        url: server.url,
        headers: await httpHeaders(server, opts),
        authProvider,
        redirect: "follow",
      },
      clientName: "abotica",
    });
  } catch (error) {
    if (authProvider) await markMcpOAuthError(server.id, error);
    throw error;
  }
}

/** Every tool the server lists, following its pages, as stored in the tool cache. */
export async function listToolDefinitions(client: MCPClient): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { params: { cursor } } : {});
    for (const t of page.tools) {
      tools.push({
        name: t.name,
        description: t.description ?? "",
        ...(t.title != null && { title: t.title }),
        inputSchema: t.inputSchema as Record<string, unknown>,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

/** Two tool lists the agent would see the same way, so the cache is rewritten only when it changed. */
export const sameToolDefinitions = (a: McpToolInfo[] | null, b: McpToolInfo[]) =>
  a !== null && JSON.stringify(a) === JSON.stringify(b);

/** Stores the tools a server exposed, so the agent form can list them without connecting. */
export async function saveMcpToolCache(serverId: string, tools: McpToolInfo[]): Promise<Date> {
  const syncedAt = new Date();
  await db.update(mcpServers).set({ tools, toolsSyncedAt: syncedAt }).where(eq(mcpServers.id, serverId));
  return syncedAt;
}

async function errorMessage(error: unknown): Promise<string> {
  if (!isUserError(error)) return error instanceof Error ? error.message : String(error);
  return translateKey(getTranslator(settingsLocale(await getSettings())), error.key, error.values);
}

/**
 * Connects once with `connect`, lists the tools and disconnects; errors come back as text, without
 * the secrets the connection resolved (the worker logs them).
 */
export async function probeMcp(
  server: McpServer,
  secrets: SecretScope,
  connect: (server: McpServer, opts: McpConnectOptions) => Promise<MCPClient>,
  timeoutMs = MCP_PROBE_TIMEOUT_MS,
): Promise<McpTestResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  const redactor = secretRedactor();
  let client: MCPClient | undefined;
  try {
    client = await connect(server, { signal, secrets, onSecrets: redactor.add });
    return { ok: true, tools: await listToolDefinitions(client) };
  } catch (error) {
    const reason = signal.aborted ? new UserError("sandbox.errors.mcpTestTimeout", { seconds: timeoutMs / 1000 }) : error;
    return { ok: false, tools: [], error: redactor.redact(await errorMessage(reason)) };
  } finally {
    await client?.close().catch(() => {});
  }
}

/** Sends a stdio server test to the worker and waits for its answer; the worker gives up by the same deadline. */
async function testInWorker(server: McpServer, timeoutMs: number): Promise<McpTestResult> {
  const events = await sandboxQueueEvents();
  const job = await sandboxQueue().add(
    "mcp-test",
    { kind: "mcp-test", server, timeoutMs },
    // Short retention: the job data names the server's secrets (references, not values).
    { attempts: 1, removeOnComplete: { age: 600 }, removeOnFail: { age: 600 } },
  );
  try {
    return (await job.waitUntilFinished(events, timeoutMs)) as McpTestResult;
  } catch (error) {
    const state = await job.getState().catch(() => "unknown");
    if (state === "waiting" || state === "active" || state === "delayed" || state === "prioritized") {
      // Not picked up (no worker) or still connecting: do not let it run after the user gave up.
      await job.remove().catch(() => {});
      const timeout = new UserError("sandbox.errors.mcpTestTimeout", { seconds: timeoutMs / 1000 });
      return { ok: false, tools: [], error: await errorMessage(timeout) };
    }
    return { ok: false, tools: [], error: await errorMessage(error) };
  }
}

/**
 * Connects once and lists the server's tools; used by the registry "Test" and "Sync tools" actions.
 * The user starts these, so the server may use any secret (the worker's `mcp-test` job does the same).
 */
export async function testMcpServer(server: McpServer, timeoutMs = MCP_TEST_TIMEOUT_MS): Promise<McpTestResult> {
  return server.transport === "stdio"
    ? testInWorker(server, timeoutMs)
    : probeMcp(server, OWNER_SECRETS, connectHttpMcp, timeoutMs);
}

/** Every own workspace a server may have: global, the user's, and one per project. */
export function mcpWorkspaceKeys(slug: string, projectIds: string[]): string[] {
  const scopes: SecretScope[] = [GLOBAL_SECRETS, OWNER_SECRETS, ...projectIds.map((projectId) => ({ projectId }))];
  return scopes.map((scope) => mcpWorkspaceKeyFor(slug, scope));
}

/**
 * Call after deleting an MCP server: its workspaces (cached packages, files) go too, in every scope,
 * so a new server under the same slug starts empty. Those of deleted projects are left to the reaper.
 */
export async function onMcpServerDeleted(slug: string): Promise<void> {
  const rows = await db.select({ id: projects.id }).from(projects);
  for (const key of mcpWorkspaceKeys(
    slug,
    rows.map((r) => r.id),
  ))
    await requestWorkspaceRemoval(key);
}
