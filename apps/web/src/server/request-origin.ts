import "server-only";
import { trustedAppOrigin } from "@abotica/core/app-origins";
import { headers } from "next/headers";

/** The origin the browser used for this request, behind a tunnel or proxy too. */
export async function requestOrigin(): Promise<string | null> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin && origin !== "null") return origin;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return null;
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** The configured public base URL (APP_URL's origin), without a trailing slash. */
export const appUrl = () => trustedAppOrigin();
