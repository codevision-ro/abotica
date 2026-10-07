import { createHash, randomBytes } from "node:crypto";
import { trustedAppOrigin } from "../../platform/app-origins";
import { redis } from "../../infra/redis";
import { decrypt, encrypt } from "../../platform/vault";
import { isSubscriptionProviderId, type SubscriptionProviderId } from "../catalog";
import {
  clearTokens,
  ensureConnection,
  isConnected,
  PLAN_NOT_GRANTED,
  readTokens,
  saveSignIn,
  setClient,
} from "./connections";
import { subscriptionProvider } from "./registry";
import { loopbackCallback } from "./callback";
import { InvalidClientError, PlanNotGrantedError } from "./types";

/** How long a started sign-in waits for its callback. */
const PENDING_TTL_SECONDS = 15 * 60;

const pendingKey = (state: string) => `abotica:subscription-sign-in:${state}`;

/** A started sign-in, kept encrypted in Redis under its state until the callback uses it once. */
type Pending = {
  provider: SubscriptionProviderId;
  clientId: string | null;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  /** The app origin to return to once the callback completes. */
  returnTo: string;
};

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** Starts a sign-in from the origin the user is on; returns the address to open. */
export async function startSubscriptionSignIn(
  provider: SubscriptionProviderId,
  origin: string | null,
): Promise<{ url: string; direct: boolean }> {
  const impl = subscriptionProvider(provider);
  const row = await ensureConnection(provider);
  const state = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(32));
  const { redirectUri, direct } = loopbackCallback(impl, origin);
  const pending: Pending = {
    provider,
    clientId: row.clientId,
    codeVerifier,
    nonce,
    redirectUri,
    returnTo: trustedAppOrigin(origin),
  };
  await redis().set(pendingKey(state), encrypt(JSON.stringify(pending)), "EX", PENDING_TTL_SECONDS);
  const url = impl.authorizationUrl({
    clientId: row.clientId,
    hostId: row.hostId,
    redirectUri,
    state,
    nonce,
    codeChallenge: base64url(createHash("sha256").update(codeVerifier).digest()),
    // The ID token identifies the account only while signed in; after signing out the email still helps.
    idTokenHint: isConnected(row) ? (readTokens(row)?.idToken ?? null) : null,
    loginHint: row.account?.email ?? null,
    // Declined before: ask again explicitly, an ordinary returning sign-in skips the consent screen.
    forceConsent: row.lastError === PLAN_NOT_GRANTED,
  });
  return { url, direct };
}

export type SignInFailure = "expired" | "denied" | "not-granted" | "failed";

/** A callback that cannot complete; `reason` is shown translated, `message` as detail. */
export class SignInCallbackError extends Error {
  constructor(
    readonly reason: SignInFailure,
    message: string,
    readonly provider?: SubscriptionProviderId,
    readonly returnTo?: string,
  ) {
    super(message);
    this.name = "SignInCallbackError";
  }
}

/**
 * Completes a sign-in from its callback parameters, whether the browser reached the callback
 * route or the user pasted the address. The state is single use. `expected` rejects a pasted
 * address that belongs to another provider's sign-in.
 */
export async function completeSignIn(
  params: URLSearchParams,
  expected?: SubscriptionProviderId,
): Promise<{ provider: SubscriptionProviderId; returnTo: string }> {
  const state = params.get("state");
  const raw = state ? await redis().getdel(pendingKey(state)) : null;
  if (!raw) throw new SignInCallbackError("expired", "Unknown, expired or already used sign-in");
  const pending = JSON.parse(decrypt(raw)) as Pending;
  const { provider, returnTo } = pending;
  const fail = (reason: SignInFailure, message: string) => new SignInCallbackError(reason, message, provider, returnTo);
  if (!isSubscriptionProviderId(provider) || (expected && provider !== expected)) {
    throw fail("failed", "The address belongs to another sign-in");
  }

  const error = params.get("error");
  if (error) {
    throw fail(error === "access_denied" ? "denied" : "failed", params.get("error_description") ?? error);
  }
  const code = params.get("code");
  if (!code) throw fail("failed", "The callback has no authorization code");

  const impl = subscriptionProvider(provider);
  const reported = impl.callbackClientId(params);
  // A reauthorization must come back for the client it started with: never mix two registrations.
  if (pending.clientId && reported && reported !== pending.clientId) {
    throw fail("failed", "The callback reports a different client than the sign-in started with");
  }
  const clientId = pending.clientId ?? reported;
  if (!clientId) throw fail("failed", "The registration did not return a client");
  if (!pending.clientId) await setClient(provider, clientId);

  try {
    const signedIn = await impl.exchangeCode({
      clientId,
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri,
      nonce: pending.nonce,
    });
    await saveSignIn(provider, signedIn);
  } catch (err) {
    if (err instanceof PlanNotGrantedError) {
      await clearTokens(provider, PLAN_NOT_GRANTED);
      throw fail("not-granted", err.message);
    }
    if (err instanceof InvalidClientError) await setClient(provider, null);
    throw fail("failed", (err as Error).message);
  }
  return { provider, returnTo };
}
