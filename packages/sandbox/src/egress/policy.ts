/**
 * Host patterns of an egress list: `example.com` (that host only), `*.example.com` (its subdomains,
 * not the domain itself) and `api.example.com:8443` (that port only). A pattern without a port allows
 * 80 and 443. "public" allows any host on any port; addresses are vetted separately.
 */
import type { Egress } from "../types";

const DEFAULT_PORTS = [80, 443];

/** Lowercase, without brackets around IPv6 literals and without a trailing dot. */
export function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65_535;

function splitAuthority(authority: string): { host: string; port: number | undefined } | null {
  const value = authority.trim();
  let host = value;
  let portText: string | undefined;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return null;
    host = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(":")) return null;
      portText = rest.slice(1);
    }
  } else {
    const colon = value.lastIndexOf(":");
    // More than one colon without brackets: a bare IPv6 literal, no port.
    if (colon >= 0 && value.indexOf(":") === colon) {
      host = value.slice(0, colon);
      portText = value.slice(colon + 1);
    }
  }
  if (!host) return null;
  if (portText === undefined) return { host: normalizeHost(host), port: undefined };
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  return validPort(port) ? { host: normalizeHost(host), port } : null;
}

/** Splits `host:port`, `[v6]:port` or a bare host (then `defaultPort`). Null when malformed. */
export function parseAuthority(authority: string, defaultPort?: number): { host: string; port: number } | null {
  const parsed = splitAuthority(authority);
  const port = parsed?.port ?? defaultPort;
  return parsed && port !== undefined ? { host: parsed.host, port } : null;
}

function matchesPattern(host: string, port: number, pattern: string): boolean {
  const parsed = splitAuthority(pattern);
  if (!parsed) return false;
  const ports = parsed.port === undefined ? DEFAULT_PORTS : [parsed.port];
  if (!ports.includes(port)) return false;
  if (parsed.host.startsWith("*.")) {
    const base = parsed.host.slice(2);
    return base.length > 0 && host.endsWith(`.${base}`);
  }
  return host === parsed.host;
}

/** Whether a connection to `host:port` is allowed by `egress` (before the address check). */
export function matchesEgress(host: string, port: number, egress: Egress): boolean {
  if (!validPort(port)) return false;
  if (egress === "public") return true;
  const name = normalizeHost(host);
  return name.length > 0 && egress.some((pattern) => matchesPattern(name, port, pattern));
}
