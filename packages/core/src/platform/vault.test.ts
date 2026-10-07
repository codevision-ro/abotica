import { isUserError } from "@abotica/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encrypt,
  getSecret,
  GLOBAL_SECRETS,
  interpolateSecrets,
  OWNER_SECRETS,
  resolveSecret,
  sealValue,
  type SecretScope,
  unsealValue,
} from "./vault";

// Rows by name, as the `secrets` table holds them: the name is unique across the vault.
const rows = vi.hoisted(() => new Map<string, { value: string; projectId: string | null }>());

// Lookups select by name only, so `eq` hands the name to `where`, which answers from `rows`.
vi.mock("@abotica/db", () => ({
  db: { select: () => ({ from: () => ({ where: async (name: string) => [rows.get(name)].filter(Boolean) }) }) },
  secrets: {},
}));
vi.mock("@abotica/db/orm", () => ({ eq: (_column: unknown, value: unknown) => value }));
vi.mock("../infra/env", () => ({ env: () => ({ VAULT_KEY: Buffer.alloc(32, 7).toString("base64") }) }));

const inProject: SecretScope = { projectId: "p1" };

/** The error a lookup failed with, or undefined when it succeeded. */
async function failure(lookup: Promise<unknown>) {
  return lookup.then(
    () => undefined,
    (error: unknown) => error,
  );
}

beforeEach(() => {
  rows.set("GLOBAL_TOKEN", { value: encrypt("global-value"), projectId: null });
  rows.set("OWN_TOKEN", { value: encrypt("own-value"), projectId: "p1" });
  rows.set("OTHER_TOKEN", { value: encrypt("other-value"), projectId: "p2" });
});

afterEach(() => {
  rows.clear();
  vi.unstubAllEnvs();
});

describe("resolveSecret", () => {
  it("reads global secrets in every scope", async () => {
    for (const scope of [inProject, GLOBAL_SECRETS, OWNER_SECRETS]) {
      expect(await resolveSecret("GLOBAL_TOKEN", scope)).toBe("global-value");
    }
  });

  it("reads the secrets of the scope's own project", async () => {
    expect(await resolveSecret("OWN_TOKEN", inProject)).toBe("own-value");
  });

  it("refuses another project's secret, without its value", async () => {
    for (const scope of [inProject, GLOBAL_SECRETS]) {
      const error = await failure(resolveSecret("OTHER_TOKEN", scope));
      expect(isUserError(error) && error.key).toBe("projects.errors.secretOtherProject");
      expect((error as Error).message).toContain("OTHER_TOKEN");
      expect((error as Error).message).not.toContain("other-value");
    }
  });

  it("gives the user every secret", async () => {
    expect(await resolveSecret("OTHER_TOKEN", OWNER_SECRETS)).toBe("other-value");
  });

  it("never falls back to the environment", async () => {
    vi.stubEnv("ENV_ONLY_TOKEN", "from-env");
    expect(await resolveSecret("ENV_ONLY_TOKEN", OWNER_SECRETS)).toBeUndefined();
  });
});

describe("getSecret", () => {
  it("reads only global secrets", async () => {
    expect(await getSecret("GLOBAL_TOKEN")).toBe("global-value");
    expect(await getSecret("OWN_TOKEN")).toBeUndefined();
    expect(await getSecret("MISSING_TOKEN")).toBeUndefined();
  });
});

describe("interpolateSecrets", () => {
  it("fills the placeholders with the secrets the scope sees", async () => {
    const record = { Authorization: "Bearer {{secret:OWN_TOKEN}}", "X-Key": "{{secret:GLOBAL_TOKEN}}" };
    expect(await interpolateSecrets(record, inProject)).toEqual({
      Authorization: "Bearer own-value",
      "X-Key": "global-value",
    });
  });

  it("keeps a `$` in a secret as it is", async () => {
    rows.set("DOLLAR_TOKEN", { value: encrypt("a$&b"), projectId: null });
    expect(await interpolateSecrets({ KEY: "{{secret:DOLLAR_TOKEN}}" }, GLOBAL_SECRETS)).toEqual({ KEY: "a$&b" });
  });

  it("opens sealed values, and reads legacy plain ones as they are", async () => {
    const record = { Authorization: sealValue("Bearer {{secret:OWN_TOKEN}}"), PLAIN: "x", SEALED: sealValue("y") };
    expect(await interpolateSecrets(record, inProject)).toEqual({
      Authorization: "Bearer own-value",
      PLAIN: "x",
      SEALED: "y",
    });
  });

  it("fails on another project's secret and on one that is not set, each with its own error", async () => {
    const other = await failure(interpolateSecrets({ KEY: "{{secret:OTHER_TOKEN}}" }, inProject));
    expect(isUserError(other) && other.key).toBe("projects.errors.secretOtherProject");

    vi.stubEnv("ENV_ONLY_TOKEN", "from-env");
    const missing = await failure(interpolateSecrets({ KEY: "{{secret:ENV_ONLY_TOKEN}}" }, inProject));
    expect(isUserError(missing) && missing.key).toBe("projects.errors.secretNotSet");
  });
});

describe("sealValue", () => {
  it("encrypts so that the text is not in the stored value, and opens it back", () => {
    const sealed = sealValue("ghp_secret");
    expect(sealed).not.toContain("ghp_secret");
    expect(sealed).not.toBe(sealValue("ghp_secret"));
    expect(unsealValue(sealed)).toBe("ghp_secret");
  });

  it("leaves a value that is already sealed as it is", () => {
    const sealed = sealValue("token");
    expect(sealValue(sealed)).toBe(sealed);
  });

  it("keeps a sealed value it cannot open (another key) instead of wrapping it twice", () => {
    const foreign = "vault:v1:sealed-with-another-key";
    expect(sealValue(foreign)).toBe(foreign);
    expect(() => unsealValue(foreign)).toThrow();
  });

  it("reads legacy plain text, including the empty string, as it is", () => {
    expect(unsealValue("plain")).toBe("plain");
    expect(unsealValue("")).toBe("");
    expect(unsealValue(sealValue(""))).toBe("");
  });
});
