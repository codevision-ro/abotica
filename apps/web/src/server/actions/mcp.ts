"use server";

import {
  audit,
  builtinMcp,
  deleteMcpServer as deleteServer,
  deleteSecret,
  detectMcpAuth,
  mcpOAuthBindingChanged,
  type McpServerValues,
  resetMcpOAuth,
  saveMcpServer,
  saveMcpToolCache,
  setMcpServerEnabled as setEnabled,
  setMcpServerGlobal as setGlobal,
  startMcpOAuth,
  upsertSecret,
} from "@abotica/core";
import { normalizeMcpServerValues, testMcpServerConnection } from "@abotica/core/mcp-servers";
import type { McpToolInfo, mcpServers } from "@abotica/db";
import { UserError } from "@abotica/i18n";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { action } from "../action";
import { getMcpServer } from "../queries/mcp";
import { requestOrigin } from "../request-origin";

type McpRow = typeof mcpServers.$inferSelect;
export type McpTestResult = { ok: boolean; tools: string[]; error?: string; durationMs: number };
type McpConnectResult = { ok: boolean; tools: McpToolInfo[]; error?: string; durationMs: number };

const TEST_TIMEOUT_MS = 20_000;

/** A saved value the form could not show is sent back as `{ keep: <its saved key> }`. */
const keep = z.object({ keep: z.string() });
const record = z.record(z.string().trim().min(1), z.union([z.string(), keep])).default({});
const optionalText = z.string().trim().max(2000).nullish();
const envName = z.string().trim().max(128);
/** Sandboxed stdio only: shape here, the rules (names, https upstream, header) in core's `normalize`. */
const credentialRoute = z.object({
  baseUrlEnv: envName,
  upstream: z.string().trim().max(2000),
  header: z.string().trim().max(256),
  value: z.union([z.string().max(4000), keep]),
  keyEnv: envName.nullish(),
});

const serverInput = z
  .object({
    name: z.string().trim().min(1, "mcp.validation.nameRequired").max(120),
    slug: z
      .string()
      .trim()
      .min(1, "mcp.validation.slugRequired")
      .max(48)
      .regex(/^[a-z0-9-]+$/, "mcp.validation.slugFormat"),
    transport: z.enum(["http", "stdio"]),
    url: z.string().trim().nullish(),
    command: z.string().trim().nullish(),
    args: z.array(z.string()).default([]),
    env: record,
    headers: record,
    auth: z.enum(["headers", "oauth"]).default("headers"),
    oauthClientId: optionalText,
    oauthClientSecret: z.union([z.string().trim().max(2000), z.object({ keep: z.literal(true) })]).nullish(),
    oauthScope: optionalText,
    /** Stdio only: validated by core's parser in `normalize`, which names the bad domain. */
    network: z.unknown().optional(),
    sandboxed: z.boolean().default(true),
    /** Stdio only: "run" starts the process in the workspace of the run that uses it. */
    workspace: z.enum(["server", "run"]).default("server"),
    credentialRoutes: z.array(credentialRoute).max(10).default([]),
    /** Seconds, or null for the default: the bounds are checked in core's `normalize` (MCP_TIMEOUTS). */
    connectTimeoutSec: z.number().nullish(),
    callTimeoutSec: z.number().nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.transport === "http") {
      if (!v.url || !z.url().safeParse(v.url).success) {
        ctx.addIssue({ code: "custom", path: ["url"], message: "mcp.validation.invalidUrl" });
      }
    } else if (!v.command) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "mcp.validation.commandRequired" });
    }
  });

/** Connects once with a timeout; a saved server also gets its tool cache refreshed on success. */
async function connect(row: McpRow, opts: { saveCache: boolean }): Promise<McpConnectResult> {
  const started = Date.now();
  const { failure, ...result } = await testMcpServerConnection(row, TEST_TIMEOUT_MS);
  if (result.ok && opts.saveCache) await saveMcpToolCache(row.id, result.tools);
  const t = await getTranslations("mcp.errors");
  const error = failure ? t(failure, { seconds: TEST_TIMEOUT_MS / 1000 }) : result.error;
  return { ...result, error, durationMs: Date.now() - started };
}

async function runTest(row: McpRow, opts: { saveCache: boolean }): Promise<McpTestResult> {
  const result = await connect(row, opts);
  return { ...result, tools: result.tools.map((tool) => tool.name).sort() };
}

async function loadServer(id: string): Promise<McpRow> {
  const row = await getMcpServer(id);
  if (!row) throw new UserError("mcp.errors.notFound");
  return row;
}

const mcpServerInput = z.object({
  server: serverInput,
  enabled: z.boolean().default(true),
  global: z.boolean().default(false),
  agentIds: z.array(z.uuid()).default([]),
  projectIds: z.array(z.uuid()).default([]),
});

function revalidateServer(id: string) {
  revalidatePath("/mcp");
  revalidatePath(`/mcp/${id}`);
  // The agent form lists the global servers.
  revalidatePath("/agents", "layout");
}

/** Inserts (no id) or updates the server and replaces its assignments. */
async function writeMcpServer(id: string | undefined, input: z.output<typeof mcpServerInput>) {
  const { server, ...rest } = input;
  const saved = id ? await loadServer(id) : null;
  const serverId = await saveMcpServer(id, { values: normalizeMcpServerValues(server, saved), ...rest });
  revalidateServer(serverId);
  return { id: serverId };
}

export const createMcpServer = action(mcpServerInput, (input) => writeMcpServer(undefined, input));

export const updateMcpServer = action(mcpServerInput.extend({ id: z.uuid() }), ({ id, ...input }) =>
  writeMcpServer(id, input),
);

/** The connection settings of a saved row; core ignores them for a bundled server and keeps the catalog's. */
const rowValues = (row: McpRow): McpServerValues => ({
  name: row.name,
  slug: row.slug,
  transport: row.transport,
  url: row.url,
  command: row.command,
  args: row.args,
  env: row.env,
  headers: row.headers,
  auth: row.auth,
  oauthClientId: row.oauthClientId,
  oauthClientSecret: row.oauthClientSecret,
  oauthScope: row.oauthScope,
  network: row.network,
  sandboxed: row.sandboxed,
  workspace: row.workspace,
  credentialRoutes: row.credentialRoutes,
  connectTimeoutSec: row.connectTimeoutSec,
  callTimeoutSec: row.callTimeoutSec,
});

/** A bundled server: only whether it is enabled, offered to every agent and its assignments change. */
export const updateBuiltinMcpServer = action(
  z.object({
    id: z.uuid(),
    enabled: z.boolean(),
    global: z.boolean(),
    agentIds: z.array(z.uuid()).default([]),
    projectIds: z.array(z.uuid()).default([]),
  }),
  async ({ id, ...rest }) => {
    const row = await loadServer(id);
    if (!row.builtin) throw new UserError("mcp.errors.notBuiltin");
    await saveMcpServer(id, { values: rowValues(row), ...rest });
    revalidateServer(id);
    return { id };
  },
);

/**
 * Tests the form as it is now, saved or not. OAuth uses the saved server's credentials,
 * so it only works for a saved server whose URL and OAuth settings are unchanged.
 */
export const testMcpDraft = action(z.object({ id: z.uuid().optional(), server: serverInput }), async ({ id, server }) => {
  const saved = id ? await loadServer(id) : null;
  const values = normalizeMcpServerValues(server, saved);
  if (values.auth === "oauth") {
    if (!saved || mcpOAuthBindingChanged(saved, values)) {
      const t = await getTranslations("mcp.errors");
      return { ok: false, tools: [], error: t("oauthSaveFirst"), durationMs: 0 } satisfies McpTestResult;
    }
    return runTest({ ...saved, ...values }, { saveCache: false });
  }
  const now = new Date();
  const draft = {
    id: "draft",
    enabled: true,
    global: false,
    builtin: null,
    createdAt: now,
    updatedAt: now,
    tools: null,
    toolsSyncedAt: null,
  } satisfies Omit<McpRow, keyof McpServerValues>;
  return runTest({ ...draft, ...values }, { saveCache: false });
});

export const testMcpById = action(z.object({ id: z.uuid() }), async ({ id }) =>
  runTest(await loadServer(id), { saveCache: true }),
);

/** Refreshes the tools a server exposes, for the per-tool permissions in the agent form. */
export const syncMcpTools = action(z.uuid(), async (serverId): Promise<{ tools: McpToolInfo[]; syncedAt: Date }> => {
  const result = await connect(await loadServer(serverId), { saveCache: false });
  if (!result.ok) throw new UserError("mcp.errors.syncFailed", { error: result.error ?? "" });
  const syncedAt = await saveMcpToolCache(serverId, result.tools);
  revalidatePath("/mcp");
  revalidatePath("/agents", "layout");
  return { tools: result.tools, syncedAt };
});

/** Suggests the authentication method for a URL typed in the form. */
export const detectMcpServerAuth = action(z.object({ url: z.url() }), async ({ url }) => ({
  auth: await detectMcpAuth(url),
}));

/** Starts the browser authorization; the client navigates to the returned URL. */
export const connectMcpOAuth = action(z.object({ id: z.uuid() }), async ({ id }): Promise<{ url: string }> => {
  const server = await loadServer(id);
  if (server.transport !== "http" || server.auth !== "oauth") throw new UserError("mcp.errors.oauthHttpOnly");
  try {
    return await startMcpOAuth(server, await requestOrigin());
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError("mcp.errors.oauthStartFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export const disconnectMcpOAuth = action(z.object({ id: z.uuid() }), async ({ id }) => {
  const server = await loadServer(id);
  await resetMcpOAuth(id);
  await audit({
    actor: "user",
    action: "mcp.disconnected",
    entityType: "mcp_server",
    entityId: id,
    data: { slug: server.slug },
  });
  revalidatePath("/mcp");
  revalidatePath(`/mcp/${id}`);
  return null;
});

export const setMcpServerEnabled = action(z.object({ id: z.uuid(), enabled: z.boolean() }), async ({ id, enabled }) => {
  await setEnabled(id, enabled);
  revalidateServer(id);
  return enabled;
});

/** Offers the server to every agent, or only to the agents and projects it is assigned to. */
export const setMcpServerGlobal = action(z.object({ id: z.uuid(), global: z.boolean() }), async ({ id, global }) => {
  await setGlobal(id, global);
  revalidateServer(id);
  return global;
});

/**
 * Stores (value) or removes (null) the optional API key of a bundled HTTP server, in the vault
 * secret its catalog entry names. The stored value is never read back.
 */
export const setBuiltinMcpKey = action(
  z.object({ id: z.uuid(), value: z.string().trim().min(1, "mcp.validation.keyRequired").max(4000).nullable() }),
  async ({ id, value }) => {
    const bundled = builtinMcp((await loadServer(id)).builtin);
    if (bundled?.transport !== "http") throw new UserError("mcp.errors.noApiKey");
    const name = bundled.apiKeySecret;
    if (value) {
      const t = await getTranslations("mcp.apiKey");
      await upsertSecret({ name, value, description: t("secretDescription", { name: bundled.name }), projectId: null });
    } else if (await deleteSecret(name)) {
      // Same entry as deleting it from the vault page.
      await audit({ actor: "user", action: "secret.deleted", entityType: "secret", entityId: name });
    }
    revalidateServer(id);
    revalidatePath("/settings/secrets");
    return value !== null;
  },
);

/** Bundled servers cannot be deleted, only disabled. */
export const deleteMcpServer = action(z.object({ id: z.uuid() }), async ({ id }) => {
  await deleteServer(id);
  revalidatePath("/mcp");
  revalidatePath("/agents", "layout");
  return null;
});
