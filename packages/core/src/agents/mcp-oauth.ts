import { randomBytes } from "node:crypto";
import {
  auth,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
  UnauthorizedError,
} from "@ai-sdk/mcp";
import { db, mcpOAuth, type McpOAuthServerInfo } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { appOrigins, originOf, trustedAppOrigin } from "../platform/app-origins";
import { decrypt, encrypt, interpolateSecrets, OWNER_SECRETS, type SecretScope } from "../platform/vault";
import type { McpServer } from "./context";

/** Stable message, matched by the web app to show a translated hint. */
export const MCP_OAUTH_REQUIRED = "OAuth authorization required";

/** The server needs the user to (re)authorize it in the browser; runs and tests cannot do that. */
class McpAuthRequiredError extends Error {
  constructor() {
    super(MCP_OAUTH_REQUIRED);
    this.name = "McpAuthRequiredError";
  }
}

/** A callback that cannot complete; `reason` is shown to the user as a translated message. */
export class McpOAuthCallbackError extends Error {
  constructor(
    readonly reason: "expired" | "denied" | "failed",
    message: string,
    readonly serverId?: string,
  ) {
    super(message);
    this.name = "McpOAuthCallbackError";
  }
}

/** How long a started authorization waits for its callback. */
const PENDING_TTL_MS = 15 * 60_000;

const CALLBACK_PATH = "/api/mcp/oauth/callback";

/**
 * The callback on the origin the user is on, so a tunnel or a second domain gets back to itself.
 * Only the app's own origins qualify, so a forged origin can never receive an authorization code.
 */
export function mcpOAuthRedirectUrl(origin?: string | null): string {
  return `${trustedAppOrigin(origin)}${CALLBACK_PATH}`;
}

/** Every callback URL, registered together so switching between the app's origins needs no new client. */
const allRedirectUrls = () => appOrigins().map((origin) => `${origin}${CALLBACK_PATH}`);

type Row = typeof mcpOAuth.$inferSelect;
type Patch = Partial<Omit<Row, "serverId" | "updatedAt">>;

async function load(serverId: string): Promise<Row | undefined> {
  const [row] = await db.select().from(mcpOAuth).where(eq(mcpOAuth.serverId, serverId));
  return row;
}

async function save(serverId: string, patch: Patch): Promise<void> {
  await db
    .insert(mcpOAuth)
    .values({ serverId, ...patch })
    .onConflictDoUpdate({ target: mcpOAuth.serverId, set: patch });
}

const readJson = <T>(value: string | null | undefined): T | undefined =>
  value ? (JSON.parse(decrypt(value)) as T) : undefined;

const writeJson = (value: unknown) => encrypt(JSON.stringify(value));

const serverUrl = (server: McpServer) => {
  if (!server.url) throw new Error(`MCP ${server.slug}: url is missing`);
  return server.url;
};

type Mode =
  /** Agent runs and tests: refreshes tokens, never starts an authorization. */
  | { kind: "runtime"; secrets: SecretScope }
  /** The user pressed Connect: always starts a new authorization, even if tokens exist. */
  | { kind: "start"; onRedirect: (url: URL) => void }
  /** The authorization server sent the user back with a code. */
  | { kind: "callback" };

type DynamicClient = OAuthClientInformation & { redirect_uris?: string[] };

function createProvider(server: McpServer, mode: Mode, redirectUrl: string): OAuthClientProvider {
  const manualClient = Boolean(server.oauthClientId);
  // Connect and its callback are the user's own steps; at runtime the caller says whose secrets apply.
  const secrets = mode.kind === "runtime" ? mode.secrets : OWNER_SECRETS;
  const redirectUrls = [redirectUrl, ...allRedirectUrls().filter((url) => url !== redirectUrl)];
  return {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "Abotica",
        redirect_uris: redirectUrls,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(server.oauthScope ? { scope: server.oauthScope } : {}),
      };
    },
    async clientInformation() {
      if (manualClient) {
        const { secret } = server.oauthClientSecret
          ? await interpolateSecrets({ secret: server.oauthClientSecret }, secrets)
          : { secret: undefined };
        return { client_id: server.oauthClientId!, ...(secret ? { client_secret: secret } : {}) };
      }
      const client = readJson<DynamicClient>((await load(server.id))?.client);
      // A client registered before this origin was trusted cannot use it: register a new one.
      if (mode.kind === "start" && client && !client.redirect_uris?.includes(redirectUrl)) return undefined;
      return client;
    },
    isClientInformationDynamicallyRegistered: () => !manualClient,
    async saveClientInformation(info) {
      // Kept with the client so a later Connect knows which callbacks it may use.
      if (!manualClient) await save(server.id, { client: writeJson({ redirect_uris: redirectUrls, ...info }) });
    },
    async tokens() {
      if (mode.kind === "start") return undefined;
      return readJson<OAuthTokens>((await load(server.id))?.tokens);
    },
    async saveTokens(tokens) {
      await save(server.id, {
        tokens: writeJson(tokens),
        expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
        lastError: null,
      });
    },
    async authorizationServerInformation() {
      return (await load(server.id))?.authServer ?? undefined;
    },
    async saveAuthorizationServerInformation(info: McpOAuthServerInfo) {
      await save(server.id, { authServer: info });
    },
    async state() {
      return randomBytes(32).toString("base64url");
    },
    async saveState(state) {
      if (mode.kind === "start") await save(server.id, { state, startedAt: new Date(), redirectUri: redirectUrl });
    },
    async storedState() {
      return (await load(server.id))?.state ?? undefined;
    },
    async saveCodeVerifier(verifier) {
      if (mode.kind === "start") await save(server.id, { codeVerifier: encrypt(verifier) });
    },
    async codeVerifier() {
      const stored = (await load(server.id))?.codeVerifier;
      if (!stored) throw new Error("The authorization was not started from Abotica");
      return decrypt(stored);
    },
    async redirectToAuthorization(url) {
      if (mode.kind !== "start") throw new McpAuthRequiredError();
      mode.onRedirect(url);
    },
    async invalidateCredentials(scope, context) {
      if (scope === "verifier") return save(server.id, { codeVerifier: null });
      if (scope === "client") return save(server.id, { client: null });
      if (scope === "tokens" && context) {
        // Another process may have refreshed meanwhile: only drop the generation that failed.
        const current = readJson<OAuthTokens>((await load(server.id))?.tokens);
        if (current && current.access_token !== context.tokens.access_token) return;
      }
      await save(server.id, {
        tokens: null,
        expiresAt: null,
        connectedAt: null,
        ...(scope === "all" ? { client: null, authServer: null, codeVerifier: null } : {}),
      });
    },
  };
}

/** Auth provider for connections made by runs and tests; fails fast when the server was never authorized. */
export async function mcpRuntimeAuthProvider(server: McpServer, secrets: SecretScope): Promise<OAuthClientProvider> {
  if (!(await load(server.id))?.tokens) throw new McpAuthRequiredError();
  // Refreshing never uses the redirect URL.
  return createProvider(server, { kind: "runtime", secrets }, mcpOAuthRedirectUrl());
}

/** Records that an authorized server stopped accepting its credentials, so the registry can ask for Reconnect. */
export async function markMcpOAuthError(serverId: string, error: unknown): Promise<void> {
  if (!(error instanceof McpAuthRequiredError || error instanceof UnauthorizedError)) return;
  await save(serverId, { lastError: (error as Error).message || MCP_OAUTH_REQUIRED }).catch(() => {});
}

const clearPending = (serverId: string) =>
  save(serverId, { state: null, codeVerifier: null, startedAt: null, redirectUri: null });

/** Starts a new authorization from the origin the user is on; returns the URL they must open. */
export async function startMcpOAuth(server: McpServer, origin?: string | null): Promise<{ url: string }> {
  let url: URL | undefined;
  await clearPending(server.id);
  const provider = createProvider(server, { kind: "start", onRedirect: (u) => (url = u) }, mcpOAuthRedirectUrl(origin));
  const result = await auth(provider, {
    serverUrl: serverUrl(server),
    scope: server.oauthScope || undefined,
  });
  if (result !== "REDIRECT" || !url) throw new Error("The authorization server did not return an authorization URL");
  return { url: url.href };
}

/**
 * Finds the server a callback belongs to by its state; throws when the state is unknown or stale.
 * `origin` is where the authorization started, so the user returns to the same address.
 */
export async function pendingMcpOAuth(state: string): Promise<{ serverId: string; origin: string | null }> {
  const [row] = await db
    .select({ serverId: mcpOAuth.serverId, startedAt: mcpOAuth.startedAt, redirectUri: mcpOAuth.redirectUri })
    .from(mcpOAuth)
    .where(eq(mcpOAuth.state, state));
  if (!row) throw new McpOAuthCallbackError("expired", "Unknown or already used authorization state");
  if (!row.startedAt || Date.now() - row.startedAt.getTime() > PENDING_TTL_MS) {
    await clearPending(row.serverId);
    throw new McpOAuthCallbackError("expired", "The authorization took too long", row.serverId);
  }
  return { serverId: row.serverId, origin: row.redirectUri ? originOf(row.redirectUri) : null };
}

/** Exchanges the code from the callback for tokens. */
export async function finishMcpOAuth(
  server: McpServer,
  params: { code: string; state: string; issuer?: string },
): Promise<void> {
  try {
    // The code exchange must repeat the exact redirect URL the authorization was started with.
    const redirectUri = (await load(server.id))?.redirectUri ?? mcpOAuthRedirectUrl();
    const result = await auth(createProvider(server, { kind: "callback" }, redirectUri), {
      serverUrl: serverUrl(server),
      authorizationCode: params.code,
      callbackState: params.state,
      callbackIssuer: params.issuer,
      scope: server.oauthScope || undefined,
    });
    if (result !== "AUTHORIZED") throw new Error("The authorization server did not issue tokens");
    await save(server.id, { connectedAt: new Date(), lastError: null });
  } catch (error) {
    // Tokens from an earlier authorization stay usable, so the failure is reported, not stored.
    throw new McpOAuthCallbackError("failed", (error as Error).message, server.id);
  } finally {
    await clearPending(server.id);
  }
}

/** The user declined (or the server refused) on the authorization page; earlier tokens stay. */
export const abortMcpOAuth = (serverId: string) => clearPending(serverId);

/**
 * Probes an HTTP MCP server without credentials to suggest how it authenticates:
 * "oauth" when it answers 401 and advertises OAuth metadata, "headers" when it needs
 * no auth or a static token, null when it cannot be reached.
 */
export async function detectMcpAuth(url: string): Promise<"oauth" | "headers" | null> {
  const signal = AbortSignal.timeout(6000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "abotica", version: "1" } },
      }),
      redirect: "follow",
      signal,
    });
    await res.body?.cancel();
  } catch {
    return null;
  }
  if (res.status !== 401) return "headers";
  if (/resource_metadata=/i.test(res.headers.get("www-authenticate") ?? "")) return "oauth";
  const { origin, pathname } = new URL(url);
  const wellKnown = [
    `/.well-known/oauth-protected-resource${pathname === "/" ? "" : pathname}`,
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
  ];
  for (const path of wellKnown) {
    const meta = await fetch(new URL(path, origin), { signal }).catch(() => null);
    await meta?.body?.cancel();
    if (meta?.ok) return "oauth";
  }
  return "headers";
}

/** Forgets every credential, including a dynamically registered client. */
export async function resetMcpOAuth(serverId: string): Promise<void> {
  await db.delete(mcpOAuth).where(eq(mcpOAuth.serverId, serverId));
}
