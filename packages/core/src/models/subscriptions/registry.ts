import type { SubscriptionProviderId } from "../catalog";
import { chatgpt } from "./chatgpt";
import type { SubscriptionProvider } from "./types";

/** A provider that can connect through a plan: `plan` on its catalog entry, and its implementation here. */
const SUBSCRIPTION_PROVIDERS: Record<SubscriptionProviderId, SubscriptionProvider> = {
  openai: chatgpt,
};

export const subscriptionProvider = (id: SubscriptionProviderId): SubscriptionProvider => SUBSCRIPTION_PROVIDERS[id];
