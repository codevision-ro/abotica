/**
 * Credential routes of sandboxed stdio MCP servers (registry.ts `McpCredentialRoute`): the secret
 * is resolved in the worker and handed to the sandbox's egress proxy with the exec, and the process
 * gets only the route's URL, plus a placeholder key for clients that insist on one.
 */
import type { McpCredentialRoute } from "@abotica/db";
import type { CredentialRoute } from "@abotica/sandbox";
import { routeUrl } from "@abotica/sandbox/routes";
import { type McpConnectOptions, resolveMcpSecrets } from "./mcp";

/** What `keyEnv` holds: never a credential, the proxy sends the real one. */
export const PROXY_MANAGED_KEY = "abotica-proxy-managed";

/** The route's id on the proxy, from its variable: OPENAI_BASE_URL is `openai-base-url`. */
export const mcpRouteId = (route: Pick<McpCredentialRoute, "baseUrlEnv">) =>
  route.baseUrlEnv.toLowerCase().replaceAll("_", "-");

/**
 * The routes of an exec and the environment they add, with each value's placeholders filled in.
 * Every value is reported to `onSecrets` whole, since the header holds a credential even when it
 * was typed in without the vault.
 */
export async function resolveMcpRoutes(
  routes: readonly McpCredentialRoute[],
  opts: McpConnectOptions,
): Promise<{ routes: CredentialRoute[]; env: Record<string, string> }> {
  if (!routes.length) return { routes: [], env: {} };
  const values = await resolveMcpSecrets(Object.fromEntries(routes.map((r, i) => [String(i), r.value])), opts);
  opts.onSecrets?.(Object.values(values));
  const env: Record<string, string> = {};
  const resolved = routes.map((route, i): CredentialRoute => {
    const id = mcpRouteId(route);
    env[route.baseUrlEnv] = routeUrl(id);
    if (route.keyEnv) env[route.keyEnv] = PROXY_MANAGED_KEY;
    return { id, upstream: route.upstream, headers: { [route.header]: values[String(i)]! } };
  });
  return { routes: resolved, env };
}
