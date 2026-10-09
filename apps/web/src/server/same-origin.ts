import { appOrigins } from "@abotica/core/app-origins";

/**
 * Refuses requests that change something unless they come from Abotica's own pages. A page on
 * another origin, an agent's preview on a subdomain included, could otherwise send them with the
 * user's session: a subdomain is the same site, so the browser attaches SameSite=Lax cookies.
 * Browsers set Sec-Fetch-Site (and Origin) on such requests and scripts cannot forge them; a request
 * with neither comes from a client that is not a browser and carries none of its cookies.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isCrossOriginWrite(request: Request): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return false;
  const origin = request.headers.get("origin");
  // APP_URL and TRUSTED_ORIGINS (tunnels, a second domain) the app is also served from.
  if (origin && appOrigins().includes(origin)) return false;
  if (site) return true;
  return origin !== null && origin !== new URL(request.url).origin;
}
