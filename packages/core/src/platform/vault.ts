import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { db, secrets } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { audit } from "./audit";
import { env } from "../infra/env";

const ALGORITHM = "aes-256-gcm";

function key(): Buffer {
  const k = Buffer.from(env().VAULT_KEY, "base64");
  if (k.length !== 32) throw new Error("VAULT_KEY must be 32 bytes, base64-encoded");
  return k;
}

/** Format: base64(iv).base64(tag).base64(ciphertext) */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string): string {
  const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !data) throw new Error("Malformed vault payload");
  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Marks a sealed value; values without it are legacy plain text and read as they are. */
const SEALED_PREFIX = "vault:v1:";

/**
 * Encrypts a value kept in a column that also held plain text before (MCP env, headers, OAuth client
 * secret). Idempotent: a value that is already sealed is returned unchanged, so a saved value carried
 * through a form round trip is not encrypted twice. That includes one sealed with another VAULT_KEY:
 * wrapping it again would hand the server the sealed text as its value, while left as it is, it fails
 * to open with a clear error until the user enters it again.
 */
export function sealValue(plain: string): string {
  return plain.startsWith(SEALED_PREFIX) ? plain : SEALED_PREFIX + encrypt(plain);
}

/** The plain value of a sealed one; legacy plain text comes back as it is. */
export function unsealValue(stored: string): string {
  return stored.startsWith(SEALED_PREFIX) ? decrypt(stored.slice(SEALED_PREFIX.length)) : stored;
}

/**
 * Which vault secrets a lookup may read. A project sees the global secrets and its own; no project
 * (null) sees only the global ones, so a run never gets the credentials of another project.
 */
export type SecretScope =
  | { projectId: string | null }
  /**
   * Every secret: for actions the user starts themselves (an MCP registry test, an OAuth Connect).
   * The user set every secret in the vault, so nothing is exposed that they could not already use.
   */
  | { owner: true };

/** Global secrets only: work that belongs to no project. */
export const GLOBAL_SECRETS: SecretScope = { projectId: null };

/** Every secret, for actions the user starts themselves (see `SecretScope`). */
export const OWNER_SECRETS: SecretScope = { owner: true };

/** Whether a secret bound to `secretProjectId` (null for a global one) can be read in `scope`. */
function secretVisibleIn(secretProjectId: string | null, scope: SecretScope): boolean {
  if ("owner" in scope) return true;
  return secretProjectId === null || secretProjectId === scope.projectId;
}

async function findSecret(name: string): Promise<{ value: string; projectId: string | null } | undefined> {
  const [row] = await db
    .select({ value: secrets.value, projectId: secrets.projectId })
    .from(secrets)
    .where(eq(secrets.name, name));
  return row;
}

/**
 * A global secret; one bound to a project counts as not set. For the app's own credentials
 * (provider API keys, the GitHub token of skill imports), which are set in the app and never in .env.
 */
export async function getSecret(name: string): Promise<string | undefined> {
  const row = await findSecret(name);
  return row?.projectId === null ? decrypt(row.value) : undefined;
}

/**
 * A secret visible in `scope`, from the vault only: the worker's own environment (DATABASE_URL,
 * VAULT_KEY) is never reachable this way. Throws when the secret belongs to another project.
 */
export async function resolveSecret(name: string, scope: SecretScope): Promise<string | undefined> {
  const row = await findSecret(name);
  if (!row) return undefined;
  if (!secretVisibleIn(row.projectId, scope)) throw new UserError("projects.errors.secretOtherProject", { name });
  return decrypt(row.value);
}

/**
 * The values of the secrets visible in `scope`, to keep them out of text that leaves the platform (a
 * conversation summary). A value that does not open (another VAULT_KEY) is skipped.
 */
export async function secretValues(scope: SecretScope): Promise<string[]> {
  const rows = await db.select({ value: secrets.value, projectId: secrets.projectId }).from(secrets);
  return rows.flatMap((row) => {
    if (!secretVisibleIn(row.projectId, scope)) return [];
    try {
      return [decrypt(row.value)];
    } catch {
      return [];
    }
  });
}

type SecretInput = {
  name: string;
  /** Empty keeps the stored value (only the description changes); required for a new secret. */
  value?: string;
  description?: string;
  /** Null for a global secret. */
  projectId?: string | null;
};

/**
 * The one write path for secrets. A secret keeps its binding (global or one project) unless the
 * caller explicitly moves it: only the vault page, which shows every secret with its owner, passes
 * `allowMove`. This stops a project page from taking over a global key such as ANTHROPIC_API_KEY.
 */
async function writeSecret(input: SecretInput, allowMove = false): Promise<{ created: boolean }> {
  const projectId = input.projectId ?? null;
  const description = input.description ?? "";
  const [existing] = await db
    .select({ id: secrets.id, projectId: secrets.projectId })
    .from(secrets)
    .where(eq(secrets.name, input.name));
  // The name is unique across the vault: it may already be bound to another project, or be global.
  if (existing && !allowMove && existing.projectId !== projectId) {
    throw new UserError("projects.errors.secretNameTaken", { name: input.name });
  }
  if (existing) {
    await db
      .update(secrets)
      .set({ description, projectId, ...(input.value && { value: encrypt(input.value) }) })
      .where(eq(secrets.id, existing.id));
    return { created: false };
  }
  if (!input.value) throw new UserError("projects.errors.secretValueRequired");
  await db.insert(secrets).values({ name: input.name, description, projectId, value: encrypt(input.value) });
  return { created: true };
}

/** Creates or replaces a secret and records it in the audit log. */
export async function upsertSecret(
  input: SecretInput,
  opts: { actor?: string; allowMove?: boolean } = {},
): Promise<{ created: boolean }> {
  const result = await writeSecret(input, opts.allowMove);
  await audit({
    actor: opts.actor ?? "user",
    action: result.created ? "secret.created" : "secret.replaced",
    entityType: "secret",
    entityId: input.name,
    data: { projectId: input.projectId ?? null },
  });
  return result;
}

/** Global secret without an audit entry: callers that log their own action (provider keys). */
export async function setSecret(name: string, value: string, description = ""): Promise<void> {
  await writeSecret({ name, value, description, projectId: null });
}

/** Deletes a secret without an audit entry: callers that log their own action (provider keys). */
export async function deleteSecret(name: string): Promise<boolean> {
  const rows = await db.delete(secrets).where(eq(secrets.name, name)).returning({ id: secrets.id });
  return rows.length > 0;
}

/**
 * Replaces `{{secret:NAME}}` placeholders with the secrets visible in `scope`, used in MCP env,
 * headers, credential routes and OAuth client secrets, and returns the secret values it put in, so
 * what a server sends back can be redacted. Values may be stored sealed (`sealValue`); they are
 * opened first.
 */
export async function resolveSecretPlaceholders(
  record: Record<string, string>,
  scope: SecretScope,
): Promise<{ values: Record<string, string>; secrets: string[] }> {
  const values: Record<string, string> = {};
  const used: string[] = [];
  for (const [k, stored] of Object.entries(record)) {
    const v = unsealValue(stored);
    let value = v;
    for (const match of v.matchAll(/\{\{secret:([A-Z0-9_]+)\}\}/g)) {
      const name = match[1]!;
      const secret = await resolveSecret(name, scope);
      if (secret === undefined) throw new UserError("projects.errors.secretNotSet", { name });
      used.push(secret);
      // A function, so a `$` in the secret is not read as a replacement pattern.
      value = value.replace(match[0], () => secret);
    }
    values[k] = value;
  }
  return { values, secrets: used };
}

/** `resolveSecretPlaceholders`, for callers that do not redact (an OAuth client secret). */
export async function interpolateSecrets(
  record: Record<string, string>,
  scope: SecretScope,
): Promise<Record<string, string>> {
  return (await resolveSecretPlaceholders(record, scope)).values;
}
