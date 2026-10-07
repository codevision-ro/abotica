import { describe, expect, it } from "vitest";
import { addressKey, isBlockedAddress, parseIPv6 } from "./addresses";

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.1.2.3",
    "100.64.0.1",
    "100.100.100.200",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "169.254.170.2",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.192",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "168.63.129.16",
    "::",
    "::1",
    "fe80::1",
    "fe80::1%eth0",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::127.0.0.1",
    "::ffff:0:10.0.0.1",
    "64:ff9b::10.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::1",
    "2002:7f00:1::1",
    "2002:a9fe:a9fe::",
    "[::1]",
    "not-an-ip",
    "",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "151.101.0.223",
    "172.32.0.1",
    "100.128.0.1",
    "192.169.0.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001:80b::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ])("allows %s", (ip) => expect(isBlockedAddress(ip)).toBe(false));

  it("blocks the host's own addresses in any notation", () => {
    const own = new Set([addressKey("203.0.114.7")!, addressKey("2a01:4f8::7")!]);
    expect(isBlockedAddress("203.0.114.7", own)).toBe(true);
    expect(isBlockedAddress("::ffff:203.0.114.7", own)).toBe(true);
    expect(isBlockedAddress("2a01:4f8:0:0::7", own)).toBe(true);
    expect(isBlockedAddress("203.0.114.8", own)).toBe(false);
  });
});

describe("parseIPv6", () => {
  it("expands compressed forms and dotted tails", () => {
    expect(parseIPv6("::1")).toEqual([...Array(15).fill(0), 1]);
    expect(parseIPv6("::ffff:1.2.3.4")?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect(parseIPv6("2001:db8::")?.slice(0, 4)).toEqual([0x20, 0x01, 0x0d, 0xb8]);
    expect(parseIPv6("1.2.3.4")).toBeNull();
  });
});
