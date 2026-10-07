/**
 * Which IP addresses a sandboxed process may connect to. Everything that is not a public unicast
 * address is refused: private and shared ranges, loopback, link-local, multicast, reserved space,
 * cloud metadata endpoints and the proxy host's own interfaces. IPv6 forms that embed an IPv4
 * address (mapped, compatible, NAT64, 6to4) are judged by the embedded address.
 */
import net from "node:net";
import os from "node:os";

type Range = { bytes: number[]; prefix: number };

const v4Range = (cidr: string): Range => {
  const [address = "", prefix = "32"] = cidr.split("/");
  return { bytes: parseIPv4(address) ?? [], prefix: Number(prefix) };
};

const v6Range = (cidr: string): Range => {
  const [address = "", prefix = "128"] = cidr.split("/");
  return { bytes: parseIPv6(address) ?? [], prefix: Number(prefix) };
};

const BLOCKED_V4 = [
  "0.0.0.0/8", // "this network", includes the unspecified address
  "10.0.0.0/8",
  "100.64.0.0/10", // CGNAT, includes Alibaba Cloud metadata 100.100.100.200
  "127.0.0.0/8",
  "169.254.0.0/16", // link-local, includes AWS/GCP/Azure/OpenStack metadata 169.254.169.254
  "172.16.0.0/12",
  "192.0.0.0/24", // IETF assignments, includes Oracle Cloud metadata 192.0.0.192
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, includes broadcast 255.255.255.255
  "168.63.129.16/32", // Azure wire server (a public address that answers only inside Azure)
].map(v4Range);

// Only 2000::/3 is global unicast; inside it these are not reachable public hosts.
const GLOBAL_V6 = v6Range("2000::/3");
const BLOCKED_V6 = [
  "2001::/23", // IETF assignments, includes Teredo 2001::/32 (embedded address is obfuscated)
  "2001:db8::/32",
  "3fff::/20",
].map(v6Range);

const inRange = (bytes: number[], { bytes: base, prefix }: Range): boolean => {
  if (bytes.length !== base.length) return false;
  for (let bit = 0; bit < prefix; bit += 8) {
    const width = Math.min(8, prefix - bit);
    const mask = (0xff << (8 - width)) & 0xff;
    const i = bit / 8;
    if (((bytes[i] ?? 0) & mask) !== ((base[i] ?? 0) & mask)) return false;
  }
  return true;
};

export function parseIPv4(ip: string): number[] | null {
  if (!net.isIPv4(ip)) return null;
  return ip.split(".").map(Number);
}

/** 16 bytes of an IPv6 address (zone id and brackets ignored), or null when it is not one. */
export function parseIPv6(input: string): number[] | null {
  let ip = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  ip = ip.split("%")[0] ?? "";
  if (!net.isIPv6(ip)) return null;
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hex = (hi: number, lo: number) => ((hi << 8) | lo).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hex(v4[0]!, v4[1]!)}:${hex(v4[2]!, v4[3]!)}`;
  }
  const [head = "", rest] = ip.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = rest ? rest.split(":") : [];
  const fill = rest === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array<string>(fill).fill("0"), ...tailGroups].map((g) => parseInt(g, 16));
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => [g >> 8, g & 0xff]);
}

/** The IPv4 address an IPv6 address carries (mapped, compatible, SIIT, NAT64 well-known, 6to4), if any. */
function embeddedIPv4(b: number[]): number[] | null {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), ::ffff:0:a.b.c.d (SIIT translated)
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return b.slice(12);
  if (zero(0, 12)) return b.slice(12);
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12)) return b.slice(12);
  // 64:ff9b::a.b.c.d (NAT64 well-known prefix)
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return b.slice(12);
  // 2002:aabb:ccdd::/48 (6to4)
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6);
  return null;
}

const v4Key = (bytes: number[]) => bytes.join(".");
const v6Key = (bytes: number[]) => bytes.map((x) => x.toString(16).padStart(2, "0")).join("");

/** Canonical form of an address, so differently written forms of the same address compare equal. */
export function addressKey(ip: string): string | null {
  const v4 = parseIPv4(ip);
  if (v4) return v4Key(v4);
  const v6 = parseIPv6(ip);
  if (!v6) return null;
  const embedded = embeddedIPv4(v6);
  return embedded ? v4Key(embedded) : v6Key(v6);
}

/** Keys (see addressKey) of every address of this machine's network interfaces. */
export function localAddresses(): Set<string> {
  const keys = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      const key = addressKey(entry.address);
      if (key) keys.add(key);
    }
  }
  return keys;
}

const blockedV4 = (bytes: number[], own: ReadonlySet<string>) =>
  BLOCKED_V4.some((range) => inRange(bytes, range)) || own.has(v4Key(bytes));

/**
 * True when a sandboxed process must not connect to `ip`. Anything that does not parse as an IP
 * address is blocked. `own` holds addressKey() values of the proxy host's interfaces.
 */
export function isBlockedAddress(ip: string, own: ReadonlySet<string> = new Set()): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return blockedV4(v4, own);
  const v6 = parseIPv6(ip);
  if (!v6) return true;
  // :: and ::1 look like IPv4-compatible 0.0.0.0 and 0.0.0.1; both are blocked as IPv4 too.
  const embedded = embeddedIPv4(v6);
  if (embedded) return blockedV4(embedded, own);
  if (!inRange(v6, GLOBAL_V6)) return true;
  return BLOCKED_V6.some((range) => inRange(v6, range)) || own.has(v6Key(v6));
}
