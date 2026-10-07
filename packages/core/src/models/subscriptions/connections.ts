import { randomUUID } from "node:crypto";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { db, subscriptionConnections } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { redis } from "../../infra/redis";
import { decrypt, encrypt } from "../../platform/vault";
import type { SubscriptionProviderId } from "../catalog";
import { subscriptionProvider } from "./registry";
import { type SignedIn, SignInRequiredError, type SubscriptionModel, type SubscriptionTokens } from "./types";

type ConnectionRow = typeof subscriptionConnections.$inferSelect;

/** Refresh this long before expiry, so a call never starts with a token about to lapse. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const LOCK_TTL_MS = 30_000;
const LOCK_POLL_MS = 250;

type StoredTokens = Pick<SubscriptionTokens, "accessToken" | "refreshToken" | "idToken">;

export async function loadConnection(provider: SubscriptionProviderId): Promise<ConnectionRow | undefined> {
  const [row] = await db.select().from(subscriptionConnections).where(eq(subscriptionConnections.provider, provider));
  return row;
}

/** The connection row, created with this installation's host id on first use; the id never changes. */
export async function ensureConnection(provider: SubscriptionProviderId): Promise<ConnectionRow> {
  await db
    .insert(subscriptionConnections)
    .values({ provider, hostId: `urn:uuid:${randomUUID()}` })
    .onConflictDoNothing();
  return (await loadConnection(provider))!;
}

export function readTokens(row: ConnectionRow | undefined): SubscriptionTokens | null {
  if (!row?.tokens) return null;
  const stored = JSON.parse(decrypt(row.tokens)) as StoredTokens;
  return { ...stored, expiresAt: row.expiresAt, scopes: row.scopes };
}

const tokenColumns = (tokens: SubscriptionTokens) => ({
  tokens: encrypt(
    JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
    } satisfies StoredTokens),
  ),
  expiresAt: tokens.expiresAt,
  scopes: tokens.scopes,
});

const update = (provider: SubscriptionProviderId, patch: Partial<ConnectionRow>) =>
  db.update(subscriptionConnections).set(patch).where(eq(subscriptionConnections.provider, provider));

/** A completed sign-in replaces the account and its tokens. */
export async function saveSignIn(provider: SubscriptionProviderId, signedIn: SignedIn): Promise<void> {
  await update(provider, {
    clientId: signedIn.clientId,
    account: signedIn.account,
    ...tokenColumns(signedIn.tokens),
    connectedAt: new Date(),
    lastError: null,
  });
}

/** Signs out locally; the client, host id and account stay so the next sign-in reuses the registration. */
export async function clearTokens(provider: SubscriptionProviderId, reason: string | null): Promise<void> {
  await update(provider, { tokens: null, expiresAt: null, scopes: [], connectedAt: null, lastError: reason });
}

/**
 * Records the client a registration issued, as soon as the callback reports it, so a failed exchange
 * does not register another one; null forgets a client the provider no longer recognizes.
 */
export async function setClient(provider: SubscriptionProviderId, clientId: string | null): Promise<void> {
  await update(provider, { clientId });
}

/** Stored as `lastError` when the account signed in without allowing use of its plan. */
export const PLAN_NOT_GRANTED = "plan-not-granted";

export const isConnected = (row: ConnectionRow | undefined): row is ConnectionRow & { tokens: string } =>
  Boolean(row?.tokens);

export async function isSubscriptionConnected(provider: SubscriptionProviderId): Promise<boolean> {
  return isConnected(await loadConnection(provider));
}

const needsRefresh = (row: ConnectionRow) =>
  row.expiresAt !== null && row.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;

/**
 * Serializes refreshes across the web app and the worker: refresh tokens rotate, so two
 * processes refreshing the same token at once would sign the account out.
 */
async function withRefreshLock<T>(provider: SubscriptionProviderId, fn: () => Promise<T>): Promise<T> {
  const key = `abotica:subscription-refresh:${provider}`;
  const owner = randomUUID();
  const deadline = Date.now() + LOCK_TTL_MS;
  while (!(await redis().set(key, owner, "PX", LOCK_TTL_MS, "NX"))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the ${provider} token refresh`);
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    // Only the owner releases: a lock that expired meanwhile may belong to another process now.
    await redis().eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
      1,
      key,
      owner,
    );
  }
}

/**
 * A usable access token, refreshed first when it is close to expiry; null when the account is
 * signed out or its refresh token was refused (the connection then records why).
 * A transient refresh failure throws and keeps the credentials.
 */
async function freshAccessToken(provider: SubscriptionProviderId): Promise<string | null> {
  const row = await loadConnection(provider);
  const tokens = readTokens(row);
  if (!row || !tokens) return null;
  if (!needsRefresh(row)) return tokens.accessToken;

  return withRefreshLock(provider, async () => {
    // Another process may have refreshed while this one waited for the lock.
    const current = await loadConnection(provider);
    const held = readTokens(current);
    if (!current || !held) return null;
    if (!needsRefresh(current)) return held.accessToken;
    if (!held.refreshToken || !current.clientId) {
      await clearTokens(provider, "The session expired and cannot be renewed");
      return null;
    }
    try {
      const next = await subscriptionProvider(provider).refresh({
        clientId: current.clientId,
        refreshToken: held.refreshToken,
      });
      await update(provider, {
        ...tokenColumns({
          ...next,
          // A refresh may leave out what did not change.
          refreshToken: next.refreshToken ?? held.refreshToken,
          idToken: next.idToken ?? held.idToken,
          scopes: next.scopes.length ? next.scopes : held.scopes,
        }),
        lastError: null,
      });
      return next.accessToken;
    } catch (error) {
      if (!(error instanceof SignInRequiredError)) throw error;
      await clearTokens(provider, error.message);
      return null;
    }
  });
}

/** The model on the signed-in account; null when it is not connected. */
export async function subscriptionLanguageModel(
  provider: SubscriptionProviderId,
  model: string,
): Promise<LanguageModelV4 | null> {
  const token = await freshAccessToken(provider);
  return token ? subscriptionProvider(provider).languageModel(token, model) : null;
}

/** The models the signed-in account may use; empty when it is not connected. */
export async function listSubscriptionModels(provider: SubscriptionProviderId): Promise<SubscriptionModel[]> {
  const token = await freshAccessToken(provider);
  return token ? subscriptionProvider(provider).listModels(token) : [];
}
