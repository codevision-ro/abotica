import { describe, expect, it } from "vitest";
import { matchesEgress, parseAuthority } from "./policy";

describe("matchesEgress", () => {
  const egress = ["pypi.org", "*.github.com", "api.example.com:8443", "[2001:4860::1]:853"];

  it.each([
    ["pypi.org", 443],
    ["pypi.org", 80],
    ["PyPI.org.", 443],
    ["api.github.com", 443],
    ["a.b.github.com", 80],
    ["api.example.com", 8443],
    ["2001:4860::1", 853],
    ["[2001:4860::1]", 853],
  ])("allows %s:%i", (host, port) => expect(matchesEgress(host, port, egress)).toBe(true));

  it.each([
    ["pypi.org", 22],
    ["files.pypi.org", 443],
    ["github.com", 443],
    ["evilgithub.com", 443],
    ["api.example.com", 443],
    ["api.example.com", 8444],
    ["example.com", 8443],
    ["", 443],
    ["pypi.org", 0],
    ["pypi.org", 70_000],
  ])("refuses %s:%i", (host, port) => expect(matchesEgress(host, port, egress)).toBe(false));

  it("allows nothing with an empty list", () => {
    expect(matchesEgress("pypi.org", 443, [])).toBe(false);
  });

  it("allows any host and port when public", () => {
    expect(matchesEgress("anything.example", 443, "public")).toBe(true);
    expect(matchesEgress("anything.example", 5432, "public")).toBe(true);
    expect(matchesEgress("anything.example", 0, "public")).toBe(false);
  });

  it("ignores malformed patterns", () => {
    expect(matchesEgress("pypi.org", 443, ["pypi.org:", "pypi.org:abc", "*.", "[::1"])).toBe(false);
  });
});

describe("parseAuthority", () => {
  it.each([
    ["example.com:443", undefined, { host: "example.com", port: 443 }],
    ["Example.COM", 80, { host: "example.com", port: 80 }],
    ["[::1]:8080", undefined, { host: "::1", port: 8080 }],
    ["2001:db8::1", 443, { host: "2001:db8::1", port: 443 }],
  ])("parses %s", (value, port, expected) => expect(parseAuthority(value, port)).toEqual(expected));

  it.each(["example.com", ":443", "example.com:0", "example.com:99999", "example.com:4a", "[::1", "[::1]x"])(
    "rejects %s",
    (value) => expect(parseAuthority(value)).toBeNull(),
  );
});
