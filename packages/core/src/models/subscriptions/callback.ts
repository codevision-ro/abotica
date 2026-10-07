import type { SubscriptionProvider } from "./types";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The loopback callback for a sign-in started from `origin`. Opened over loopback, the browser
 * reaches the app's own callback route on the same port (`direct`); otherwise the address it
 * lands on cannot load and the user pastes it back into the app.
 */
export function loopbackCallback(
  provider: Pick<SubscriptionProvider, "callbackPath" | "fallbackPort">,
  origin: string | null,
): { redirectUri: string; direct: boolean } {
  let url: URL | null = null;
  try {
    url = origin ? new URL(origin) : null;
  } catch {
    url = null;
  }
  const direct = url?.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  const port = direct ? url!.port || "80" : String(provider.fallbackPort);
  return { redirectUri: `http://127.0.0.1:${port}${provider.callbackPath}`, direct };
}
