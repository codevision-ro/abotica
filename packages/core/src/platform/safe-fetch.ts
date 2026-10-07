/**
 * Outbound HTTP for URLs that agents or users choose (web_fetch, knowledge links). The worker shares
 * networks with the Docker API proxy, Postgres and Redis, so only public addresses are reached: the
 * address is checked when the connection is made (no DNS rebinding window), every redirect hop is
 * checked again, and bodies are read up to a size cap.
 */
import { isBlockedAddress, localAddresses } from "@abotica/sandbox/addresses";
import dns from "node:dns";
import net from "node:net";
import { Agent, fetch, type Response } from "undici";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 20_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type SafeFetchErrorCode = "protocol" | "credentials" | "blocked" | "redirects";

/** A request refused before it reached the target. `message` is English, for logs and the model. */
export class SafeFetchError extends Error {
  override name = "SafeFetchError";
  constructor(
    public readonly code: SafeFetchErrorCode,
    public readonly host: string,
  ) {
    super(
      {
        protocol: "Only http and https URLs can be fetched",
        credentials: "URLs with a user name or password cannot be fetched",
        blocked: `${host} is a private or internal address and cannot be fetched`,
        redirects: `Too many redirects (more than ${MAX_REDIRECTS})`,
      }[code],
    );
  }
}

/**
 * Parses and checks a URL before any request: http(s) only, no credentials, and a literal IP host
 * must be public (a connection to an IP address skips the DNS lookup that checks names).
 */
export function checkUrl(input: string | URL, own: ReadonlySet<string> = new Set()): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("protocol", url.host);
  if (url.username || url.password) throw new SafeFetchError("credentials", url.host);
  // The URL parser already turned forms like 2130706433 or 0x7f.1 into dotted IPv4.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedAddress(host, own)) throw new SafeFetchError("blocked", url.hostname);
  return url;
}

/** The resolved addresses a connection may use; throws when none is public. */
export function allowedAddresses(
  hostname: string,
  addresses: dns.LookupAddress[],
  own: ReadonlySet<string> = new Set(),
): dns.LookupAddress[] {
  const allowed = addresses.filter((a) => !isBlockedAddress(a.address, own));
  if (!allowed.length) throw new SafeFetchError("blocked", hostname);
  return allowed;
}

type LookupCallback = (error: Error | null, address: string | dns.LookupAddress[], family?: number) => void;

/** net.connect's `lookup`: resolves, drops blocked addresses, and hands only vetted ones to connect. */
function vettedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    let allowed: dns.LookupAddress[];
    try {
      allowed = allowedAddresses(hostname, addresses, localAddresses());
    } catch (refused) {
      return callback(refused as Error, []);
    }
    if (options.all) return callback(null, allowed);
    callback(null, allowed[0]!.address, allowed[0]!.family);
  });
}

let agent: Agent | undefined;
const dispatcher = () => (agent ??= new Agent({ connect: { lookup: vettedLookup } }));

export type SafeFetchOptions = {
  /** The caller's signal (a cancelled run); combined with the timeout. */
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

/**
 * GET to a public address, following up to 5 redirects that are each checked again. Refusals throw
 * SafeFetchError; network errors and timeouts throw as fetch does (a timeout as "TimeoutError"). The
 * timeout also covers reading the body; read it with readTextCapped.
 */
export async function safeFetch(input: string | URL, options: SafeFetchOptions = {}): Promise<Response> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let url = checkUrl(input, localAddresses());
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(url, { signal, headers: options.headers, redirect: "manual", dispatcher: dispatcher() });
    } catch (error) {
      // undici reports a refused lookup as "fetch failed" with the refusal as its cause.
      const cause = (error as { cause?: unknown }).cause;
      throw cause instanceof SafeFetchError ? cause : error;
    }
    const location = res.headers.get("location");
    if (!REDIRECT_STATUSES.has(res.status) || !location) return res;
    await res.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new SafeFetchError("redirects", url.host);
    url = checkUrl(new URL(location, url), localAddresses());
  }
}

/**
 * Reads a body as UTF-8 text, stopping at `maxBytes` instead of buffering a body of any size. A cut
 * in the middle of a character decodes to a replacement character.
 */
export async function readTextCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}
