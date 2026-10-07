import { describe, expect, it, vi } from "vitest";
import {
  mcpOAuthBindingChanged,
  type McpServerDraft,
  mcpTestFailure,
  normalizeMcpServerValues,
  openMcpCredentials,
  sealMcpCredentials,
} from "./mcp-servers";
import { MCP_OAUTH_REQUIRED } from "../agents/mcp-oauth";
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
  ...overrides,
});

const saved = { env: { TOKEN: sealValue("old-token") }, headers: {}, oauthClientSecret: sealValue("old") };

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

  it("runs an unsandboxed stdio server in no workspace of a run", () => {
    expect(normalizeMcpServerValues(draft({ sandboxed: false }), null).workspace).toBe("server");
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

describe("sealMcpCredentials", () => {
  const plain = { env: { A: "a" }, headers: { Authorization: "Bearer {{secret:X}}" }, oauthClientSecret: "s" };

  it("stores no value in plain text and opens back to the same values", () => {
    const sealed = sealMcpCredentials(plain);
    expect(JSON.stringify(sealed)).not.toMatch(/"a"|Bearer|"s"/);
    expect(openMcpCredentials(sealed)).toEqual(plain);
  });

  it("is idempotent, so a kept value is not encrypted twice", () => {
    const sealed = sealMcpCredentials(plain);
    expect(sealMcpCredentials(sealed)).toEqual(sealed);
  });

  it("leaves empty records and a missing secret alone", () => {
    const empty = { env: {}, headers: {}, oauthClientSecret: null };
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
