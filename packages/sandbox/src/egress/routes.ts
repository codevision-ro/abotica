/**
 * Credential routes (types.ts `CredentialRoute`): how a request to a route maps onto its upstream.
 * A route is addressed as `http://routes.abotica.invalid/<id>/<path>`: a reserved name that never
 * resolves, so only a client going through the egress proxy reaches it (NO_PROXY is empty in the
 * sandbox) and one that bypasses the proxy fails instead of sending anything elsewhere. The upstream
 * comes from the route alone, never from the request's Host, and a path that would leave the
 * upstream's base path is refused. Pure and free of the Docker backend, so core checks routes with
 * the same rules when they are saved.
 */
import type { OutgoingHttpHeaders } from "node:http";
import type { CredentialRoute } from "../types";

export const ROUTE_HOST = "routes.abotica.invalid";

/** The URL a process uses for the route: requests below it go below the route's upstream. */
export const routeUrl = (id: string) => `http://${ROUTE_HOST}/${id}`;

const ROUTE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers a route cannot set: the proxy owns them. */
const RESERVED_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "proxy-authorization"]);

/** An id a route may have; it is the first path segment of the route's URL. */
export const isRouteId = (id: string) => ROUTE_ID_RE.test(id);

/** An upstream a route may have: an https URL without credentials, query or fragment. */
export function isRouteUpstream(upstream: string): boolean {
  if (!URL.canParse(upstream)) return false;
  const url = new URL(upstream);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}

/** A header a route may set: a valid name the proxy does not own, with a value on one line. */
export const isRouteHeader = (name: string, value: string) =>
  HEADER_NAME_RE.test(name) && !RESERVED_HEADERS.has(name.toLowerCase()) && !/[\r\n\0]/.test(value);

/** A route checked and parsed once, when its exec is registered. */
export type ResolvedRoute = {
  id: string;
  upstream: URL;
  /** The upstream's path without a trailing slash: "" for a whole host. */
  basePath: string;
  /** Lowercase names, so a client's header of any case is replaced. */
  headers: Record<string, string>;
};

/**
 * Checks a route and parses it. Throws on a malformed one; the messages never quote header values,
 * which hold the secret.
 */
export function resolveRoute(route: CredentialRoute): ResolvedRoute {
  if (!isRouteId(route.id)) throw new Error(`Invalid credential route id: ${route.id}`);
  if (!isRouteUpstream(route.upstream)) {
    throw new Error(
      `Credential route ${route.id}: the upstream must be an https URL without credentials, query or fragment`,
    );
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(route.headers)) {
    if (!isRouteHeader(name, value)) throw new Error(`Credential route ${route.id}: invalid header ${name}`);
    headers[name.toLowerCase()] = value;
  }
  const upstream = new URL(route.upstream);
  return { id: route.id, upstream, basePath: upstream.pathname.replace(/\/+$/, ""), headers };
}

/**
 * Splits a request's path and query into the route id and the rest below it: `/<id>` alone, or
 * followed by `/` or `?`. Null for anything else (a bare `/`, `/<id>-other`).
 */
export function parseRouteTarget(pathAndQuery: string): { id: string; rest: string } | null {
  const match = /^\/([^/?]+)([/?].*)?$/s.exec(pathAndQuery);
  if (!match?.[1] || !ROUTE_ID_RE.test(match[1])) return null;
  return { id: match[1], rest: match[2] ?? "" };
}

/** The part of `url` below the route's base (path and query), or null when it is outside the base. */
function restBelow(route: ResolvedRoute, url: URL): string | null {
  if (url.protocol !== route.upstream.protocol || url.host !== route.upstream.host) return null;
  const { pathname } = url;
  if (pathname !== route.basePath && !pathname.startsWith(`${route.basePath}/`)) return null;
  return pathname.slice(route.basePath.length) + url.search;
}

/**
 * The upstream URL of a request below the route. Null when the path would leave the base: the URL
 * parser already removed dot segments, and the result is checked again after joining.
 */
export function upstreamUrl(route: ResolvedRoute, rest: string): URL | null {
  const query = rest.indexOf("?");
  const path = query === -1 ? rest : rest.slice(0, query);
  const url = new URL(route.upstream.href);
  url.pathname = route.basePath + path;
  url.search = query === -1 ? "" : rest.slice(query);
  return restBelow(route, url) === null ? null : url;
}

/**
 * The client's headers for the upstream: its own authorization and any header the route sets are
 * dropped, the route's are added, and Host names the upstream.
 */
export function upstreamHeaders(route: ResolvedRoute, headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key !== "host" && key !== "authorization" && !(key in route.headers)) out[key] = value;
  }
  return { ...out, ...route.headers, host: route.upstream.host };
}

/**
 * A redirect from the upstream as the client should follow it: one below the route's base goes back
 * through the route, any other goes where the upstream sent it, as an absolute URL (a relative one
 * would resolve against the route), and the client follows it on its own, without the route's
 * credentials. The proxy never follows redirects itself.
 */
export function routeLocation(route: ResolvedRoute, location: string, requested: URL): string {
  let target: URL;
  try {
    target = new URL(location, requested);
  } catch {
    return location;
  }
  const rest = restBelow(route, target);
  return rest === null ? target.href : routeUrl(route.id) + rest;
}
