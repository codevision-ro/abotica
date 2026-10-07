import { UserError } from "@abotica/i18n";
import { deleteSecret, setSecret } from "../platform/vault";
import { isSubscriptionProviderId, type ProviderId, refreshCatalog } from "./catalog";
import { PROVIDER_KEY_SECRET } from "./providers";
import { disconnectSubscription } from "./subscriptions/accounts";
import { isSubscriptionConnected } from "./subscriptions/connections";

function keyName(provider: ProviderId): string {
  const name = PROVIDER_KEY_SECRET[provider];
  if (!name) throw new UserError("settings.errors.noApiKey");
  return name;
}

/**
 * Saves a provider's API key in the vault. A provider connected through its plan switches to the
 * key: the plan is signed out first, since a provider is reached one way or the other.
 */
export async function saveProviderKey(provider: ProviderId, value: string, description: string): Promise<void> {
  const name = keyName(provider);
  if (isSubscriptionProviderId(provider) && (await isSubscriptionConnected(provider))) {
    await disconnectSubscription(provider);
  }
  await setSecret(name, value, description);
  await refreshCatalog().catch(() => {});
}

export async function removeProviderKey(provider: ProviderId): Promise<void> {
  await deleteSecret(keyName(provider));
  await refreshCatalog().catch(() => {});
}
