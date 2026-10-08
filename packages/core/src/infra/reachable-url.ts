/** Host names that mean "this machine" to whoever reads the address. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `url` as this process can reach it. Users enter addresses as their machine sees them
 * (http://localhost:11434), but inside a container localhost is the container itself: with `gateway`
 * set (HOST_GATEWAY, e.g. host.docker.internal) a loopback host becomes the gateway. Any other address
 * (http://ollama:11434, a host on the network) passes through unchanged, as does everything without one.
 */
export function reachableUrl(url: string, gateway: string | undefined): string {
  if (!gateway) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return url;
  parsed.hostname = gateway;
  return parsed.toString();
}

/** An http(s) address without its trailing slash, or null when `value` is not one. */
export function parseHttpUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString().replace(/\/+$/, "");
}
