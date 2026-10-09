import type { SignInFailure } from "@abotica/core";

type SubscriptionOutcome = "connected" | SignInFailure;

/** Query parameters the models page (Settings > Models) reads after a subscription sign-in, then removes. */
export const SUBSCRIPTION_RETURN_PARAMS = { outcome: "subscription", provider: "provider", message: "message" } as const;

/** The models page, where the providers are, on `origin`, carrying how a subscription sign-in ended. */
export function subscriptionReturnUrl(
  origin: string,
  result: { outcome: SubscriptionOutcome; provider?: string; message?: string },
): URL {
  const url = new URL("/settings/models", origin);
  url.searchParams.set(SUBSCRIPTION_RETURN_PARAMS.outcome, result.outcome);
  if (result.provider) url.searchParams.set(SUBSCRIPTION_RETURN_PARAMS.provider, result.provider);
  if (result.message) url.searchParams.set(SUBSCRIPTION_RETURN_PARAMS.message, result.message.slice(0, 300));
  return url;
}
