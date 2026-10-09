import type { SubscriptionAccount } from "@abotica/db";
import { audit } from "../../platform/audit";
import { deleteSecret } from "../../platform/vault";
import { refreshCatalog, type SubscriptionProviderId } from "../catalog";
import { PROVIDER_KEY_SECRET } from "../providers";
import { clearTokens, isConnected, loadConnection, PLAN_NOT_GRANTED, readTokens } from "./connections";
import { completeSignIn } from "./sign-in";
import { subscriptionProvider } from "./registry";

/** Why a connection is not usable although the user signed in before. */
type SubscriptionProblem =
  | { kind: "plan-not-granted" }
  /** The provider refused the session (expired, revoked, disconnected from its settings). */
  | { kind: "session-ended"; detail: string };

export type SubscriptionStatus = {
  connected: boolean;
  account: SubscriptionAccount | null;
  connectedAt: Date | null;
  problem: SubscriptionProblem | null;
  usageUrl: string;
};

function problemOf(lastError: string | null | undefined): SubscriptionProblem | null {
  if (!lastError) return null;
  return lastError === PLAN_NOT_GRANTED ? { kind: "plan-not-granted" } : { kind: "session-ended", detail: lastError };
}

export async function getSubscriptionStatus(provider: SubscriptionProviderId): Promise<SubscriptionStatus> {
  const row = await loadConnection(provider);
  const connected = isConnected(row);
  return {
    connected,
    account: connected ? (row.account ?? null) : null,
    connectedAt: connected ? row.connectedAt : null,
    problem: connected ? null : problemOf(row?.lastError),
    usageUrl: subscriptionProvider(provider).usageUrl,
  };
}

/** The account's models join the catalog as soon as it connects, and leave it when it disconnects. */
const refreshModels = () => refreshCatalog().catch(() => {});

/**
 * Completes a sign-in from its callback (route or pasted address), then lists the account's models.
 * The provider is reached through its plan from now on, so its API key is removed.
 */
export async function connectSubscription(
  params: URLSearchParams,
  expected?: SubscriptionProviderId,
): Promise<{ provider: SubscriptionProviderId; returnTo: string }> {
  const result = await completeSignIn(params, expected);
  const keyName = PROVIDER_KEY_SECRET[result.provider];
  if (keyName && (await deleteSecret(keyName))) {
    await audit({
      actor: "user",
      action: "provider.key-removed",
      entityType: "secret",
      entityId: keyName,
      data: { provider: result.provider, reason: "plan-connected" },
    });
  }
  const { account } = await getSubscriptionStatus(result.provider);
  await audit({
    actor: "user",
    action: "subscription.connected",
    entityType: "provider",
    entityId: result.provider,
    data: { email: account?.email ?? null },
  });
  await refreshModels();
  return result;
}

/**
 * Signs out: ends the renewable session at the provider, then drops the tokens. Returns whether
 * the provider confirmed it; if not, the user can still disconnect the app from the provider's settings.
 */
export async function disconnectSubscription(provider: SubscriptionProviderId): Promise<{ revoked: boolean }> {
  const row = await loadConnection(provider);
  const tokens = readTokens(row);
  let revoked = true;
  if (row?.clientId && tokens?.refreshToken) {
    revoked = await subscriptionProvider(provider)
      .revoke({ clientId: row.clientId, refreshToken: tokens.refreshToken })
      .then(() => true)
      .catch(() => false);
  }
  await clearTokens(provider, null);
  await audit({
    actor: "user",
    action: "subscription.disconnected",
    entityType: "provider",
    entityId: provider,
    data: { revoked },
  });
  await refreshModels();
  return { revoked };
}
