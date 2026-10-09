/**
 * MCP connections of agent runs, worker only: stdio servers start processes (in the sandbox, or
 * directly for servers the admin trusts), so this module is not exported from the package index.
 *
 * A server whose tool cache holds the full definitions is offered without connecting: its process
 * starts (or its URL is called) on the first tool call of the run. Most runs never call most of the
 * servers they could, and a browser server costs a process and hundreds of megabytes.
 *
 * Sandboxed stdio servers run as the sandbox's MCP user, never as the user of agent commands, and
 * never start inside a workspace the agent writes; their own workspaces are keyed by server and
 * secret scope (`mcpWorkspaceKeyFor`).
 *
 * What a server sends back (results, errors with its stderr) loses the run's secrets before it is
 * capped, stored or wrapped for the model: the ones its connection resolved, the run's repository
 * tokens, and well-known token shapes (redact.ts).
 */
import { type MCPClient, createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { McpToolInfo } from "@abotica/db";
import { isUserError, UserError } from "@abotica/i18n";
import type { Workspace } from "@abotica/sandbox";
import { shellQuote } from "@abotica/sandbox/shell";
import { dynamicTool, type JSONSchema7, jsonSchema, type Tool, type ToolSet } from "ai";
import { touchWorkspace } from "../sandbox/sandbox";
import { DEFAULT_MCP_NETWORK, setupEgressFor } from "../sandbox/sandbox-policy";
import { withoutHiddenTools } from "../mcp/mcp-builtins";
import { syncBuiltinMcpServers } from "../mcp/mcp-servers";
import { MCP_TIMEOUTS } from "../mcp/mcp-stored-values";
import { currentSandboxBackend } from "../sandbox/sandbox-runtime";
import { GLOBAL_SECRETS, type SecretScope } from "../platform/vault";
import type { McpServer } from "./context";
import {
  connectHttpMcp,
  listToolDefinitions,
  type McpConnectOptions,
  type McpTestResult,
  type McpToolSource,
  probeMcp,
  resolveMcpSecrets,
  saveMcpToolCache,
  sameToolDefinitions,
} from "./mcp";
import { resolveMcpRoutes } from "./mcp-routes";
import { SandboxMcpTransport } from "./mcp-sandbox-transport";
import { mcpToolDefault, mcpToolHint } from "./permissions";
import { type SecretRedactor, secretRedactor } from "./redact";
import { capToolText, type FullOutputTarget, fullOutputTarget, toolTextMax, type ToolOutputWorkspace } from "./tool-output";
import { mcpWorkspaceKeyFor } from "../sandbox/sandbox-keys";
import { wrapUntrusted } from "./untrusted";
import { markerId } from "./untrusted-id";

export type McpConnection = {
  tools: ToolSet;
  /** Keyed by runtime tool name. */
  sources: Record<string, McpToolSource>;
  close: () => Promise<void>;
  errors: { server: string; error: unknown }[];
};

export type McpRunOptions = McpConnectOptions & {
  /**
   * The run's own workspace, for servers set to run there; null or missing when the run has none,
   * and those servers fall back to their own workspace.
   */
  runWorkspace?: (() => Promise<Workspace>) | null;
  /** A server that could not start on its first tool call; the call itself fails with the error. */
  onLazyError?: (server: string, error: unknown) => void;
  /**
   * The run's sandbox and id: a result cut for the model keeps its full text in the workspace. Null
   * or missing when the run has none, and the cut middle is not kept.
   */
  toolOutput?: ToolOutputWorkspace | null;
  /** A result went to the model as untrusted data: every MCP result does, also when a replay rebuilds it. */
  onUntrusted?: () => void;
  /** Redacted from what the servers send back, besides the secrets their connections resolve: the repository tokens. */
  knownSecrets?: readonly string[];
  /** How long a tool call waits for its answer when the server sets no time of its own; MCP_CALL_TIMEOUT_MS when missing. */
  callTimeoutMs?: number;
  /** How long a server may take to start and answer the handshake when it sets no time of its own; MCP_CONNECT_TIMEOUT_MS when missing. */
  connectTimeoutMs?: number;
};

/**
 * How long a tool call waits for the server's answer. `@ai-sdk/mcp` has no default, so a server
 * that never answers would hold the run until its own time limit; past this the call fails instead.
 */
export const MCP_CALL_TIMEOUT_MS = MCP_TIMEOUTS.callSec.default * 1000;

/**
 * How long a server may take to start: long enough for `npx -y` or `uvx` to download it on a first
 * start, short enough that a server stuck before its handshake does not hold the run.
 */
export const MCP_CONNECT_TIMEOUT_MS = MCP_TIMEOUTS.connectSec.default * 1000;

/** A server's own timeout (its form's Advanced section), else the run's, else the default. */
const serverTimeoutMs = (serverSec: number | null | undefined, runMs: number | undefined, defaultMs: number) =>
  serverSec ? serverSec * 1000 : (runMs ?? defaultMs);

/** The only host variables an unsandboxed stdio server gets; the worker's secrets stay out. */
function hostBaseEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "LANG"]) {
    const value = process.env[name];
    if (value) out[name] = value;
  }
  return out;
}

/** Adds what the server printed on stderr to a connection error; a bare "Connection closed" says nothing. */
function withStderr(error: unknown, stderr: string): unknown {
  if (!stderr || isUserError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}: ${stderr}`, { cause: error });
}

/**
 * The folder a stdio server starts in and keeps its files in, in a run's workspace: outside the
 * volume and written only by the MCP user, so the agent can read what the server saves there but
 * cannot plant what npx, uvx or python -m would load from a working folder (.npmrc, pyproject.toml,
 * node_modules, modules) nor swap the folder for a link into the MCP user's private home. Null for
 * a backend without such folders: the server then starts where the backend puts it.
 */
const mcpOutputFolder = (workspace: Workspace, slug: string) =>
  workspace.paths.mcpOutput ? `${workspace.paths.mcpOutput}/${slug}` : null;

/** The workspace a stdio server runs in: the run's when it asks for it and the run has one, else its own. */
async function stdioWorkspace(
  server: McpServer,
  opts: McpRunOptions,
): Promise<{ workspace: Workspace; folder: string | null }> {
  if (server.workspace === "run" && opts.runWorkspace) {
    const workspace = await opts.runWorkspace();
    return { workspace, folder: mcpOutputFolder(workspace, server.slug) };
  }
  const backend = currentSandboxBackend();
  if (!backend) throw new UserError("sandbox.errors.mcpNeedsSandbox");
  const key = mcpWorkspaceKeyFor(server.slug, opts.secrets);
  const workspace = await backend.open({ key, owner: "mcp" });
  await touchWorkspace(key).catch(() => {});
  // Its own workspace belongs to the MCP user and no agent works there: it starts in the workspace.
  return { workspace, folder: null };
}

/** A connected server, with the folder of its files the agent can read (null when it has none). */
type McpConnected = { client: MCPClient; folder: string | null };

/**
 * A stdio server inside a sandbox workspace, as the MCP user, with the network its own policy allows
 * and its credential routes.
 */
async function connectSandboxedStdio(
  server: McpServer,
  env: Record<string, string>,
  opts: McpRunOptions,
): Promise<McpConnected> {
  // Job data serialized before the column existed has no routes.
  const routes = await resolveMcpRoutes(server.credentialRoutes ?? [], opts);
  const { workspace, folder } = await stdioWorkspace(server, opts);
  // `npx -y` and `uvx` download the server when it starts, so the registries are always reachable.
  // The egress belongs to this process, so in a run's workspace it does not widen the agent's own.
  const egress = setupEgressFor(server.network ?? DEFAULT_MCP_NETWORK);
  // exec: the server replaces the shell, so killing the process stops the server itself. The folder
  // is created by the MCP user, inside one only that user writes.
  const start = `exec ${[server.command!, ...server.args].map(shellQuote).join(" ")}`;
  const command = folder ? `mkdir -p -- ${shellQuote(folder)} && cd -- ${shellQuote(folder)} && ${start}` : start;
  const transport = new SandboxMcpTransport(() =>
    workspace.exec({
      command,
      env: { ...env, ...routes.env },
      egress,
      routes: routes.routes,
      stdin: "pipe",
      signal: opts.signal,
      user: "mcp",
    }),
  );
  try {
    return { client: await createMCPClient({ transport, clientName: "abotica" }), folder };
  } catch (error) {
    await transport.close();
    throw withStderr(error, transport.stderrTail());
  }
}

/** A stdio server the admin chose to run directly in the worker (trusted command), with a clean env. */
async function connectHostStdio(server: McpServer, env: Record<string, string>, opts: McpConnectOptions) {
  const transport = new Experimental_StdioMCPTransport({
    command: server.command!,
    args: server.args,
    env: { ...hostBaseEnv(), ...env },
  });
  opts.signal?.addEventListener("abort", () => void transport.close(), { once: true });
  try {
    return await createMCPClient({ transport, clientName: "abotica" });
  } catch (error) {
    await transport.close();
    throw error;
  }
}

async function connectMcp(server: McpServer, opts: McpRunOptions): Promise<McpConnected> {
  if (server.transport === "http") return { client: await connectHttpMcp(server, opts), folder: null };
  if (!server.command) throw new Error(`MCP ${server.slug}: command is missing`);
  const env = await resolveMcpSecrets(server.env, opts);
  // Rows serialized before the column existed (or drafts from the form) count as sandboxed.
  if (server.sandboxed === false) return { client: await connectHostStdio(server, env, opts), folder: null };
  return connectSandboxedStdio(server, env, opts);
}

/**
 * connectMcp with a deadline. The signal the connection gets aborts only when the deadline passes
 * before the handshake, so a server that started stays up for the rest of the run; on the deadline its
 * process or request is stopped, and a connection that still completes late is closed.
 */
async function connectWithin(server: McpServer, opts: McpRunOptions): Promise<McpConnected> {
  const deadlineMs = serverTimeoutMs(server.connectTimeoutSec, opts.connectTimeoutMs, MCP_CONNECT_TIMEOUT_MS);
  const deadline = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
  const connecting = connectMcp(server, { ...opts, signal });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      deadline.abort();
      reject(new Error(`MCP ${server.slug} did not start within ${Math.round(deadlineMs / 1000)} s`));
    }, deadlineMs);
  });
  connecting.then(
    (late) => {
      if (deadline.signal.aborted) void late.client.close().catch(() => {});
    },
    () => {},
  );
  try {
    return await Promise.race([connecting, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Tool names are prefixed with the server slug so two servers never collide. */
const prefix = (slug: string) => slug.replace(/[^a-zA-Z0-9]/g, "_");

/** A cache the run can build every tool from without asking the server. */
const isComplete = (tools: McpToolInfo[] | null): tools is McpToolInfo[] =>
  tools !== null && tools.length > 0 && tools.every((t) => t.inputSchema);

type McpCallResult = Awaited<ReturnType<MCPClient["callTool"]>>;

/** A call's result as `execute` returns it: the server's, with Abotica's note on where its files are. */
type McpToolOutput = McpCallResult & { folderNote?: string };

/**
 * What the model reads from a tool result: its text, and images as files (as `@ai-sdk/mcp` does).
 * Everything the server wrote goes in as untrusted data, under an id derived from the tool call so
 * a replay gives the same bytes; the folder note is Abotica's own and follows outside the blocks.
 */
function modelOutput(slug: string, onUntrusted: (() => void) | undefined) {
  return ({ toolCallId, output }: { toolCallId: string; output: unknown }) => {
    const { folderNote, ...result } = output as McpToolOutput;
    const wrap = (text: string) => wrapUntrusted(text, { source: `mcp:${slug}`, id: markerId(toolCallId) });
    const note = folderNote ? [{ type: "text" as const, text: folderNote }] : [];
    onUntrusted?.();
    if (!("content" in result) || !Array.isArray(result.content)) {
      return { type: "content" as const, value: [{ type: "text" as const, text: wrap(JSON.stringify(result)) }, ...note] };
    }
    return {
      type: "content" as const,
      value: [
        ...result.content.map((part) =>
          part.type === "image"
            ? { type: "file" as const, mediaType: part.mimeType, data: { type: "data" as const, data: part.data } }
            : { type: "text" as const, text: wrap(part.type === "text" ? part.text : JSON.stringify(part)) },
        ),
        ...note,
      ],
    };
  };
}

/**
 * Caps the text parts of a result together at toolTextMax. Over it, they become one part in
 * place of the first, cut in the middle, so its lines match the saved full text; other parts keep
 * their order. A result within the limit comes back as it is.
 */
async function capResult(result: McpCallResult, target: FullOutputTarget | null): Promise<McpCallResult> {
  if (!("content" in result) || !Array.isArray(result.content)) return result;
  const texts = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  if (texts.reduce((sum, text) => sum + text.length, 0) <= toolTextMax(target)) return result;
  const { text } = await capToolText(texts.join("\n"), target);
  const first = result.content.findIndex((part) => part.type === "text");
  const content = result.content.flatMap((part, i) =>
    part.type !== "text" ? [part] : i === first ? [{ ...part, text }] : [],
  );
  return { ...result, content };
}

/**
 * A call the server answered with `isError`, thrown so the AI SDK records it as a failed call. Its
 * message is the server's text, which the chat and the run's events show. The model reads the error as
 * the AI SDK writes it, `String(error)`: that text wrapped as untrusted data, like every MCP result, and
 * exactly as a replay wraps the stored error (untrusted-results.ts), so both give the same bytes.
 */
export class McpToolError extends Error {
  override readonly name = "McpToolError";
  readonly #forModel: string;

  constructor(message: string, forModel: string) {
    super(message);
    this.#forModel = forModel;
  }

  override toString(): string {
    return this.#forModel;
  }
}

/** The text of an error result, as the model reads a result: images left out, other parts as JSON. */
function errorResultText(result: McpCallResult): string {
  if (!("content" in result) || !Array.isArray(result.content)) return JSON.stringify(result);
  const text = result.content
    .flatMap((part) => (part.type === "image" ? [] : [part.type === "text" ? part.text : JSON.stringify(part)]))
    .join("\n");
  return text || "The MCP server reported an error without a message.";
}

/** A relative path such as `./page.png`, which is how Playwright links the files it saves. */
const RELATIVE_PATH = /(?:^|[\s(["'`])\.\.?\//m;

/**
 * A server in a run's workspace names the files it saves relative to its own folder, not to the
 * agent's working directory; a result that mentions such a path tells the agent where they are.
 */
function folderNote(result: McpCallResult, folder: string): string | undefined {
  if (!("content" in result) || !Array.isArray(result.content)) return undefined;
  if (!result.content.some((part) => part.type === "text" && RELATIVE_PATH.test(part.text))) return undefined;
  return (
    `Relative paths above are inside ${folder}, where this tool saves files. Read or share a file there ` +
    `by its full path (${folder}/<name>); it is read-only for you, so copy it into your workspace to change it.`
  );
}

/** Binary parts are base64: no secret is readable there, and a token shape could match by chance. */
const isBinaryPart = (part: { type: string; resource?: unknown }) =>
  part.type === "image" ||
  part.type === "audio" ||
  (part.type === "resource" && typeof part.resource === "object" && part.resource !== null && "blob" in part.resource);

/** The result without the secrets `redactor` knows, binary parts left as they are. */
function redactResult(result: McpCallResult, redactor: SecretRedactor): McpCallResult {
  if (!("content" in result) || !Array.isArray(result.content)) return redactor.redact(result);
  const { content, ...rest } = result;
  return { ...redactor.redact(rest), content: content.map((part) => (isBinaryPart(part) ? part : redactor.redact(part))) };
}

/** An error's text without the secrets `redactor` knows; a UserError is Abotica's own text and stays. */
function redactError(error: unknown, redactor: SecretRedactor): unknown {
  if (isUserError(error)) return error;
  return new Error(redactor.redact(error instanceof Error ? error.message : String(error)));
}

/**
 * A server's connection for the run's calls: made on the first call (or given), and dropped by
 * `reset` so the next call starts the server again.
 */
type ServerConnection = {
  connect: () => Promise<McpConnected>;
  reset: (connected: McpConnected) => void;
};

/** What the model reads when a call outlived the timeout, worded so it does not try the same call again. */
const callTimeoutText = (tool: string, timeoutMs: number) =>
  `${tool} did not answer within ${Math.round(timeoutMs / 1000)} s. Do not call it again with the same arguments; use another tool or approach.`;

/** One server's tools, built from its definitions; the server is only connected on a call. */
function serverTools(
  server: McpServer,
  definitions: McpToolInfo[],
  connection: ServerConnection,
  opts: McpRunOptions,
  redactor: SecretRedactor,
): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  const toModelOutput = modelOutput(server.slug, opts.onUntrusted);
  // As a replay names it: from the runtime tool name, which is all a stored message keeps.
  const errorSource = `mcp:${prefix(server.slug)}` as const;
  const callMs = serverTimeoutMs(server.callTimeoutSec, opts.callTimeoutMs, MCP_CALL_TIMEOUT_MS);
  for (const definition of definitions) {
    // As `@ai-sdk/mcp` builds it: no extra keys, and an object even when the server lists no properties.
    const schema = (definition.inputSchema ?? { type: "object" }) as JSONSchema7;
    tools[definition.name] = dynamicTool({
      description: definition.description,
      ...(definition.title && { title: definition.title }),
      inputSchema: jsonSchema({ ...schema, properties: schema.properties ?? {}, additionalProperties: false }),
      execute: async (args, options) => {
        options?.abortSignal?.throwIfAborted();
        const connected = await connection.connect();
        const { client, folder } = connected;
        const timeout = AbortSignal.timeout(callMs);
        const signal = options?.abortSignal ? AbortSignal.any([options.abortSignal, timeout]) : timeout;
        const result = await client
          .callTool({ name: definition.name, arguments: args as Record<string, unknown>, options: { signal } })
          .catch((error: unknown): McpCallResult => {
            // A cancelled run still stops. Any other failure of the call fails it like an error result.
            if (options?.abortSignal?.aborted) throw error;
            if (timeout.aborted) {
              // A stdio server that leaves a call unanswered may be stuck as a whole (one whose writer
              // died answers nothing more), and later calls would queue behind it: the next call
              // starts a fresh process. Calls still waiting on this one fail with it. Over HTTP every
              // request stands alone, so the connection stays.
              if (server.transport === "stdio") connection.reset(connected);
              const text = callTimeoutText(`${prefix(server.slug)}__${definition.name}`, callMs);
              return { isError: true, content: [{ type: "text", text }] };
            }
            const message = error instanceof Error ? error.message : String(error);
            return { isError: true, content: [{ type: "text", text: message }] };
          });
        const capped = await capResult(redactResult(result, redactor), fullOutputTarget(opts.toolOutput, options));
        if ("isError" in capped && capped.isError) {
          const message = errorResultText(capped);
          opts.onUntrusted?.();
          throw new McpToolError(
            message,
            wrapUntrusted(message, { source: errorSource, id: markerId(options.toolCallId) }),
          );
        }
        // Set on every result, so a `folderNote` the server sends itself never reaches the model unwrapped.
        const output: McpToolOutput = { ...capped, folderNote: folder ? folderNote(capped, folder) : undefined };
        return output;
      },
      toModelOutput,
    });
  }
  return tools;
}

export async function loadMcpTools(servers: McpServer[], runOpts: McpRunOptions): Promise<McpConnection> {
  const clients: MCPClient[] = [];
  const errors: McpConnection["errors"] = [];
  let closed = false;
  const redactor = secretRedactor(runOpts.knownSecrets);
  const opts: McpRunOptions = { ...runOpts, onSecrets: redactor.add };

  /**
   * Connects once (or starts from `initial`); a failed start is retried on the next call rather than
   * remembered, and a reset connection is closed and made again on the next call.
   */
  const lazyClient = (server: McpServer, initial?: McpConnected): ServerConnection => {
    let pending: Promise<McpConnected> | null = initial ? Promise.resolve(initial) : null;
    let current: McpConnected | null = initial ?? null;
    const connect = () => {
      pending ??= connectWithin(server, opts).then(
        async (connected) => {
          const { client } = connected;
          // The run ended while the server was starting: nothing would close it later.
          if (closed) {
            await client.close().catch(() => {});
            throw new Error("The run has ended");
          }
          clients.push(client);
          current = connected;
          // The server may have changed since the cache was written; the next run uses the new list.
          const listed = await listToolDefinitions(client).catch(() => null);
          const definitions = listed && withoutHiddenTools(server.builtin, listed);
          if (definitions && !sameToolDefinitions(server.tools, definitions)) {
            await saveMcpToolCache(server.id, definitions).catch(() => {});
          }
          return connected;
        },
        (failure: unknown) => {
          pending = null;
          const error = redactError(failure, redactor);
          opts.onLazyError?.(server.slug, error);
          throw error;
        },
      );
      return pending;
    };
    const reset = (connected: McpConnected) => {
      // Only the connection the call used: another call may already have started a new one.
      if (current !== connected) return;
      current = null;
      pending = null;
      const index = clients.indexOf(connected.client);
      if (index >= 0) clients.splice(index, 1);
      void connected.client.close().catch(() => {});
    };
    return { connect, reset };
  };

  const listings = await Promise.all(
    servers.map(async (server) => {
      if (isComplete(server.tools)) {
        // A cache written before a tool was hidden still lists it.
        const definitions = withoutHiddenTools(server.builtin, server.tools);
        return {
          server,
          definitions,
          tools: serverTools(server, definitions, lazyClient(server), opts, redactor),
        };
      }
      // No usable cache yet: connect now, list the tools and remember them for the next runs.
      try {
        const connected = await connectWithin(server, opts);
        clients.push(connected.client);
        const definitions = withoutHiddenTools(server.builtin, await listToolDefinitions(connected.client));
        // The cache only feeds the agent form and later runs; a failed write must never fail this one.
        if (!sameToolDefinitions(server.tools, definitions)) await saveMcpToolCache(server.id, definitions).catch(() => {});
        return {
          server,
          definitions,
          tools: serverTools(server, definitions, lazyClient(server, connected), opts, redactor),
        };
      } catch (error) {
        errors.push({ server: server.slug, error: redactError(error, redactor) });
        return null;
      }
    }),
  );

  // In server order, not connection order: tools open the prompt, and a different order on the next
  // run would miss the whole prompt cache.
  const tools: ToolSet = {};
  const sources: Record<string, McpToolSource> = {};
  for (const listing of listings) {
    if (!listing) continue;
    for (const { name, annotations } of listing.definitions) {
      const runtimeName = `${prefix(listing.server.slug)}__${name}`;
      tools[runtimeName] = listing.tools[name]!;
      sources[runtimeName] = {
        serverSlug: listing.server.slug,
        tool: name,
        defaultPermission: mcpToolDefault(annotations, listing.server.builtin),
        readOnly: mcpToolHint(annotations) === "readOnly",
      };
    }
  }
  return {
    tools,
    sources,
    errors,
    close: async () => {
      closed = true;
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}

/** Connects once in the worker and lists the server's tools (the `mcp-test` job). */
export function probeMcpServer(server: McpServer, secrets: SecretScope, timeoutMs?: number): Promise<McpTestResult> {
  return probeMcp(server, secrets, async (s, o) => (await connectMcp(s, o)).client, timeoutMs);
}

/**
 * At worker start: brings the bundled servers' rows in line with the catalog, then fills the tool
 * cache of the enabled ones that have none, so runs can offer their tools without starting them.
 */
export async function prepareBuiltinMcpServers(): Promise<void> {
  const rows = await syncBuiltinMcpServers();
  for (const server of rows.filter((r) => r.enabled && !isComplete(r.tools))) {
    if (server.transport === "stdio" && !currentSandboxBackend()) continue;
    // Nobody asked for this listing: the server gets the global secrets only.
    const result = await probeMcpServer(server, GLOBAL_SECRETS);
    if (result.ok) await saveMcpToolCache(server.id, withoutHiddenTools(server.builtin, result.tools));
    else console.error(`[mcp] listing the tools of ${server.slug} failed: ${result.error}`);
  }
}
