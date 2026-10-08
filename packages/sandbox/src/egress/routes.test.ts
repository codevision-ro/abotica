import { describe, expect, it } from "vitest";
import { parseRouteTarget, resolveRoute, routeLocation, routeUrl, upstreamHeaders, upstreamUrl } from "./routes";

const repo = resolveRoute({
  id: "git-site",
  upstream: "https://github.com/acme/site.git",
  headers: { Authorization: "Basic c2VjcmV0" },
});

describe("resolveRoute", () => {
  it("keeps the base path without a trailing slash and lowercases header names", () => {
    const api = resolveRoute({ id: "openai", upstream: "https://api.openai.com/v1/", headers: { "X-Api-Key": "k" } });
    expect(api.basePath).toBe("/v1");
    expect(api.headers).toEqual({ "x-api-key": "k" });
    expect(resolveRoute({ id: "host", upstream: "https://example.com", headers: {} }).basePath).toBe("");
  });

  it("refuses routes the proxy could not serve safely, without quoting header values", () => {
    const bad = (route: Partial<Parameters<typeof resolveRoute>[0]>) => () =>
      resolveRoute({ id: "r", upstream: "https://example.com", headers: {}, ...route });
    expect(bad({ id: "Bad/Id" })).toThrow("Invalid credential route id");
    for (const upstream of ["http://example.com", "https://user:pw@example.com", "https://example.com/?x=1", "nope"]) {
      expect(bad({ upstream }), upstream).toThrow("the upstream must be an https URL");
    }
    expect(bad({ headers: { Host: "evil.example" } })).toThrow("invalid header Host");
    expect(bad({ headers: { "Bad Name": "x" } })).toThrow("invalid header");
    const injected = bad({ headers: { Authorization: "secret-value\r\nX: y" } });
    expect(injected).toThrow("invalid header Authorization");
    expect(injected).not.toThrow("secret-value");
  });
});

describe("parseRouteTarget", () => {
  it("splits the id from the rest at a slash or a query", () => {
    expect(parseRouteTarget("/git-site")).toEqual({ id: "git-site", rest: "" });
    expect(parseRouteTarget("/git-site/info/refs?service=git-upload-pack")).toEqual({
      id: "git-site",
      rest: "/info/refs?service=git-upload-pack",
    });
    expect(parseRouteTarget("/openai?x=1")).toEqual({ id: "openai", rest: "?x=1" });
  });

  it("finds no route in a bare slash or an id that is not one", () => {
    expect(parseRouteTarget("/")).toBeNull();
    expect(parseRouteTarget("/Upper/x")).toBeNull();
    expect(parseRouteTarget("")).toBeNull();
  });
});

describe("upstreamUrl", () => {
  it("puts the rest below the base path", () => {
    expect(upstreamUrl(repo, "/info/refs?service=git-upload-pack")?.href).toBe(
      "https://github.com/acme/site.git/info/refs?service=git-upload-pack",
    );
    expect(upstreamUrl(repo, "")?.href).toBe("https://github.com/acme/site.git");
  });

  it("never leaves the base path or the host", () => {
    expect(upstreamUrl(repo, "/../other.git/info/refs")).toBeNull();
    expect(upstreamUrl(repo, "/%2e%2e/other.git/info/refs")).toBeNull();
    expect(upstreamUrl(repo, "//evil.example/x")?.host).toBe("github.com");
    expect(upstreamUrl(repo, "/x@evil.example")?.host).toBe("github.com");
  });
});

describe("upstreamHeaders", () => {
  it("replaces the client's authorization and Host with the route's", () => {
    const headers = upstreamHeaders(repo, {
      host: "evil.example",
      authorization: "Bearer abotica-proxy-managed",
      "user-agent": "git/2.54",
    });
    expect(headers).toEqual({ "user-agent": "git/2.54", authorization: "Basic c2VjcmV0", host: "github.com" });
  });

  it("drops a client header the route sets, in any case", () => {
    const route = resolveRoute({ id: "r", upstream: "https://api.example.com", headers: { "X-Api-Key": "real" } });
    expect(upstreamHeaders(route, { "x-api-key": "dummy", authorization: "Bearer dummy" })).toEqual({
      "x-api-key": "real",
      host: "api.example.com",
    });
  });
});

describe("routeLocation", () => {
  const requested = new URL("https://github.com/acme/site.git/info/refs?service=git-upload-pack");

  it("sends a redirect below the base back through the route", () => {
    expect(routeLocation(repo, "/acme/site.git/mirror/info/refs?service=git-upload-pack", requested)).toBe(
      `${routeUrl("git-site")}/mirror/info/refs?service=git-upload-pack`,
    );
    expect(routeLocation(repo, "https://github.com/acme/site.git", requested)).toBe(routeUrl("git-site"));
  });

  it("sends any other redirect where the upstream pointed, as an absolute URL", () => {
    for (const location of [
      "https://github.com/acme/renamed.git/info/refs",
      "https://github.com/acme/site.git-fork/info/refs",
      "https://evil.example/acme/site.git/info/refs",
      "http://github.com/acme/site.git/info/refs",
    ]) {
      expect(routeLocation(repo, location, requested)).toBe(location);
    }
    expect(routeLocation(repo, "/acme/renamed.git/info/refs", requested)).toBe(
      "https://github.com/acme/renamed.git/info/refs",
    );
    expect(routeLocation(repo, "http://[bad", requested)).toBe("http://[bad");
  });
});
