import { isUserError } from "@abotica/i18n";
import { describe, expect, it, vi } from "vitest";
import {
  type McpCredentialRouteDraft,
  mcpOAuthBindingChanged,
  type McpServerDraft,
  mcpTestFailure,
  normalizeCredentialRoutes,
  normalizeMcpServerValues,
  openMcpCredentials,
  sealMcpCredentials,
} from "./mcp-servers";
import { MCP_OAUTH_REQUIRED } from "../agents/mcp-oauth";
import { MCP_TIMEOUTS } from "./mcp-stored-values";
import { sealValue } from "../platform/vault";

// Only the pure parts are tested: nothing here reaches the database.
vi.mock("@abotica/db", () => ({ db: {} }));
vi.mock("../infra/env", () => ({ env: () => ({ VAULT_KEY: Buffer.alloc(32, 9).toString("base64") }) }));

const draft = (overrides: Partial<McpServerDraft> = {}): McpServerDraft => ({
  name: "Tracker",
  slug: "tracker",
  transport: "stdio",
  url: "https://example.com/mcp",
  command: "npx",
  args: [" -y ", "tracker-mcp", ""],
  env: { TOKEN: "{{secret:TRACKER_TOKEN}}" },
  headers: { Authorization: "Bearer x" },
  auth: "oauth",
  oauthClientId: "client",
  oauthClientSecret: "client-secret",
  oauthScope: "read",
  network: { mode: "off", domains: [] },
  sandboxed: true,
  workspace: "run",
  credentialRoutes: [route()],
  ...overrides,
});

function route(overrides: Partial<McpCredentialRouteDraft> = {}): McpCredentialRouteDraft {
  return {
    baseUrlEnv: "OPENAI_BASE_URL",
    upstream: " https://api.openai.com/v1 ",
    header: "Authorization",
    value: "Bearer {{secret:OPENAI_KEY}}",
    keyEnv: "OPENAI_API_KEY",
    ...overrides,
  };
}

const saved = {
  env: { TOKEN: sealValue("old-token") },
  headers: {},
  credentialRoutes: [
    { baseUrlEnv: "OPENAI_BASE_URL", upstream: "https://x", header: "Authorization", value: sealValue("k") },
  ],
  oauthClientSecret: sealValue("old"),
};

describe("normalizeMcpServerValues", () => {
  it("keeps only the stdio fields of a stdio server", () => {
    const values = normalizeMcpServerValues(draft(), null);
    expect(values).toMatchObject({
      url: null,
      command: "npx",
      args: ["-y", "tracker-mcp"],
      headers: {},
      auth: "headers",
      oauthClientId: null,
      oauthClientSecret: null,
      oauthScope: null,
      network: { mode: "off", domains: [] },
      workspace: "run",
    });
  });

  it("keeps only the http fields of an http server, which is always sandboxed in its own workspace", () => {
    const values = normalizeMcpServerValues(draft({ transport: "http", sandboxed: false }), null);
    expect(values).toMatchObject({
      url: "https://example.com/mcp",
      command: null,
      args: [],
      env: {},
      headers: { Authorization: "Bearer x" },
      auth: "oauth",
      oauthClientSecret: "client-secret",
      sandboxed: true,
      workspace: "server",
    });
  });

  it("runs an unsandboxed stdio server in no workspace of a run and with no credential routes", () => {
    const values = normalizeMcpServerValues(draft({ sandboxed: false }), null);
    expect(values).toMatchObject({ workspace: "server", credentialRoutes: [] });
    expect(normalizeMcpServerValues(draft({ transport: "http" }), null).credentialRoutes).toEqual([]);
  });

  it("drops a client secret without its client id, and takes kept values from the saved row", () => {
    const http = { transport: "http" as const };
    expect(normalizeMcpServerValues(draft({ ...http, oauthClientId: "" }), null).oauthClientSecret).toBeNull();
    const kept = normalizeMcpServerValues(
      draft({ env: { TOKEN: { keep: "TOKEN" } }, oauthClientSecret: { keep: true } }),
      saved,
    );
    expect(kept.env).toEqual({ TOKEN: saved.env.TOKEN });
    const keptSecret = normalizeMcpServerValues(draft({ ...http, oauthClientSecret: { keep: true } }), saved);
    expect(keptSecret.oauthClientSecret).toBe(saved.oauthClientSecret);
  });
});

describe("normalizeCredentialRoutes", () => {
  it("trims the fields and leaves out an empty key variable", () => {
    expect(normalizeCredentialRoutes([route({ keyEnv: " " })], null)).toEqual([
      {
        baseUrlEnv: "OPENAI_BASE_URL",
        upstream: "https://api.openai.com/v1",
        header: "Authorization",
        value: "Bearer {{secret:OPENAI_KEY}}",
      },
    ]);
  });

  it("takes a kept value from the saved route of the same variable", () => {
    const [kept] = normalizeCredentialRoutes([route({ value: { keep: "OPENAI_BASE_URL" } })], saved.credentialRoutes);
    expect(kept?.value).toBe(saved.credentialRoutes[0]!.value);
  });

  it("refuses what the sandbox could not run, naming the route", () => {
    const failure = (routes: McpCredentialRouteDraft[]) => {
      try {
        normalizeCredentialRoutes(routes, null);
      } catch (error) {
        return isUserError(error) ? [error.key, error.values] : error;
      }
      return null;
    };
    const named = { name: "OPENAI_BASE_URL" };
    expect(failure([route({ baseUrlEnv: "1BAD" })])).toEqual(["mcp.errors.routeEnvName", { name: "1BAD" }]);
    expect(failure([route({ keyEnv: "BAD-NAME" })])).toEqual(["mcp.errors.routeEnvName", { name: "BAD-NAME" }]);
    expect(failure([route(), route({ baseUrlEnv: "openai_base_url" })])).toEqual([
      "mcp.errors.routeDuplicate",
      { name: "openai_base_url" },
    ]);
    expect(failure([route({ upstream: "http://api.openai.com/v1" })])).toEqual(["mcp.errors.routeUpstream", named]);
    expect(failure([route({ value: " " })])).toEqual(["mcp.errors.routeValueRequired", named]);
    expect(failure([route({ header: "Host" })])).toEqual(["mcp.errors.routeHeader", named]);
    expect(failure([route({ value: "a\r\nX-Injected: 1" })])).toEqual(["mcp.errors.routeHeader", named]);
  });
});

describe("sealMcpCredentials", () => {
  const plain = {
    env: { A: "a" },
    headers: { Authorization: "Bearer {{secret:X}}" },
    credentialRoutes: [{ baseUrlEnv: "API_URL", upstream: "https://api.example.com", header: "X-Key", value: "k-value" }],
    oauthClientSecret: "s",
  };

  it("stores no value in plain text and opens back to the same values", () => {
    const sealed = sealMcpCredentials(plain);
    expect(JSON.stringify(sealed)).not.toMatch(/"a"|Bearer|"s"|k-value/);
    expect(openMcpCredentials(sealed)).toEqual(plain);
  });

  it("is idempotent, so a kept value is not encrypted twice", () => {
    const sealed = sealMcpCredentials(plain);
    expect(sealMcpCredentials(sealed)).toEqual(sealed);
  });

  it("leaves empty records and a missing secret alone", () => {
    const empty = { env: {}, headers: {}, credentialRoutes: [], oauthClientSecret: null };
    expect(sealMcpCredentials(empty)).toEqual(empty);
  });

  it("reads legacy plain values as they are", () => {
    expect(openMcpCredentials(plain)).toEqual(plain);
  });
});

describe("mcpOAuthBindingChanged", () => {
  const binding = {
    transport: "http" as const,
    url: "https://example.com/mcp",
    auth: "oauth" as const,
    oauthClientId: "client",
    oauthClientSecret: "secret",
    oauthScope: null,
  };

  it("compares the client secret by value, however it is stored", () => {
    const stored = { ...binding, oauthClientSecret: sealValue("secret") };
    expect(mcpOAuthBindingChanged(stored, binding)).toBe(false);
    expect(mcpOAuthBindingChanged(stored, { ...binding, oauthClientSecret: sealValue("secret") })).toBe(false);
    expect(mcpOAuthBindingChanged(stored, { ...binding, oauthClientSecret: "other" })).toBe(true);
    expect(mcpOAuthBindingChanged(stored, { ...binding, oauthClientSecret: null })).toBe(true);
  });

  it("notices a change of any other setting", () => {
    expect(mcpOAuthBindingChanged(binding, { ...binding, url: "https://example.com/other" })).toBe(true);
  });
});

describe("mcpTestFailure", () => {
  it("names the failures whose message says nothing to the user", () => {
    expect(mcpTestFailure("fetch failed")).toBe("fetchFailed");
    expect(mcpTestFailure("Attempted to send a request from a closed client")).toBe("processClosed");
    expect(mcpTestFailure(MCP_OAUTH_REQUIRED)).toBe("oauthRequired");
    expect(mcpTestFailure("Unauthorized")).toBe("oauthRequired");
    expect(mcpTestFailure("ENOENT: npx")).toBeUndefined();
    expect(mcpTestFailure(undefined)).toBeUndefined();
  });
});

describe("server timeouts", () => {
  /** The message key a draft fails with. */
  const failure = (overrides: Partial<McpServerDraft>) => {
    try {
      normalizeMcpServerValues(draft(overrides), null);
    } catch (error) {
      return isUserError(error) ? { key: error.key, values: error.values } : error;
    }
    return undefined;
  };

  it("keeps whole seconds within the bounds, and null for the default", () => {
    expect(normalizeMcpServerValues(draft(), null)).toMatchObject({ connectTimeoutSec: null, callTimeoutSec: null });
    const values = normalizeMcpServerValues(draft({ connectTimeoutSec: 300, callTimeoutSec: 600 }), null);
    expect(values).toMatchObject({ connectTimeoutSec: 300, callTimeoutSec: 600 });
  });

  it("refuses a timeout outside its bounds, naming them", () => {
    const { min, max } = MCP_TIMEOUTS.connectSec;
    expect(failure({ connectTimeoutSec: min - 1 })).toEqual({ key: "mcp.validation.connectTimeout", values: { min, max } });
    expect(failure({ connectTimeoutSec: 30.5 })).toMatchObject({ key: "mcp.validation.connectTimeout" });
    expect(failure({ callTimeoutSec: MCP_TIMEOUTS.callSec.max + 1 })).toMatchObject({ key: "mcp.validation.callTimeout" });
  });
});
