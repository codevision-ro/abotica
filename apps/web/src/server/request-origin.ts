import "server-only";
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

/** The configured public base URL, without a trailing slash. */
export const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
