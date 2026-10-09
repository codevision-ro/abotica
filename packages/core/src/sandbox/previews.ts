/**
 * Previews: links to what agents made, each on its own subdomain of PREVIEW_URL and served by the
 * worker (preview-server.ts). A static preview serves a copy of workspace files, kept under the
 * uploads folder in `previews/<id>`; a live one reaches a port of the workspace's container.
 *
 * Access: a public preview needs only its link. A private one sends the visitor through the app
 * (`/preview/<id>`), which checks the session and hands out a ticket: signed, bound to the preview,
 * valid for a minute and usable once. The preview host trades it for its own cookie, signed and
 * bound to the preview too. The app's session never reaches a preview host.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { db, previews } from "@abotica/db";
import { and, desc, eq, gt, inArray, lte, type SQL } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { audit } from "../platform/audit";
import { env } from "../infra/env";
import { getSettings, type PreviewSettings } from "../settings/settings";
import type { SnapshotFile } from "./preview-snapshot";
import { redis } from "../infra/redis";
import { resolveUpload } from "../files/uploads";

export type Preview = typeof previews.$inferSelect;
export type PreviewKind = Preview["kind"];

const HOUR_MS = 3600_000;

/**
 * How long a preview lives (Settings > Previews), renewed by "extend" and, for a static one, by
 * publishing it again. A change applies from the next renewal; links already open keep their expiry.
 */
export function previewTtlMs(kind: PreviewKind, settings: PreviewSettings): number {
  return kind === "live" ? settings.liveHours * HOUR_MS : settings.staticDays * 24 * HOUR_MS;
}

const PREVIEWS_DIR = "previews";
const TICKET_TTL_MS = 60_000;
/** A cookie lasts as long as its preview, at most this long, then the visitor goes through the app again. */
const COOKIE_MAX_MS = 24 * HOUR_MS;
const TICKET_USED_KEY = "abotica:preview:ticket:";
const HOST_RE = /^[a-z2-7]{26}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 128 random bits in lowercase base32: a DNS label nobody can guess. */
function newHost(): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

const previewBase = () => new URL(env().PREVIEW_URL);

/** The preview's address; `pathname` may carry a query. */
export function previewUrl(preview: Pick<Preview, "host">, pathname = "/"): string {
  const base = previewBase();
  return `${base.protocol}//${preview.host}.${base.host}${pathname}`;
}

/** A host name without its port, lowercase. */
const hostname = (host: string) => host.toLowerCase().replace(/:\d+$/, "");

/**
 * The preview code in a host name (`<code>.<preview host>`, with or without a port: a Host header
 * has one, the TLS question of the reverse proxy does not), or null when it names none.
 */
export function previewHostOf(host: string | undefined): string | null {
  const base = previewBase().hostname.toLowerCase();
  const name = hostname(host ?? "");
  if (!name.endsWith(`.${base}`)) return null;
  const label = name.slice(0, -base.length - 1);
  return HOST_RE.test(label) ? label : null;
}

/** Whether previews are served over HTTPS, which decides the cookie's prefix and Secure flag. */
export const previewsSecure = () => previewBase().protocol === "https:";

/** Folder of a static preview's copy. */
export function previewDir(id: string): string {
  const dir = resolveUpload(path.join(PREVIEWS_DIR, id));
  if (!dir || path.basename(dir) !== id) throw new Error(`Invalid preview id ${id}`);
  return dir;
}

export type PreviewOwner = { projectId: string } | { conversationId: string };

const ownerColumns = (owner: PreviewOwner) => ({
  projectId: "projectId" in owner ? owner.projectId : null,
  conversationId: "conversationId" in owner ? owner.conversationId : null,
});

const ownerCondition = (owner: PreviewOwner): SQL =>
  "projectId" in owner ? eq(previews.projectId, owner.projectId) : eq(previews.conversationId, owner.conversationId);

const expiry = async (kind: PreviewKind) => new Date(Date.now() + previewTtlMs(kind, (await getSettings()).previews));

type CreatedBy = { agentId: string | null; runId: string | null };

/** Opens a link to a port of the workspace's container. */
export async function createLivePreview(
  input: { owner: PreviewOwner; workspaceKey: string; port: number; title: string; public: boolean } & CreatedBy,
): Promise<Preview> {
  const [row] = await db
    .insert(previews)
    .values({
      host: newHost(),
      kind: "live",
      title: input.title,
      ...ownerColumns(input.owner),
      workspaceKey: input.workspaceKey,
      port: input.port,
      public: input.public,
      expiresAt: await expiry("live"),
      agentId: input.agentId,
      runId: input.runId,
    })
    .returning();
  await auditPreview("preview.created", row!, input.agentId);
  return row!;
}

/** Writes a copy next to the old one and swaps them, so a visitor never sees half of it. */
async function writeCopy(id: string, files: SnapshotFile[]): Promise<void> {
  const dir = previewDir(id);
  const staging = `${dir}.new-${randomBytes(4).toString("hex")}`;
  const old = `${dir}.old-${randomBytes(4).toString("hex")}`;
  try {
    for (const file of files) {
      const target = path.join(staging, ...file.path.split("/"));
      if (!target.startsWith(staging + path.sep)) throw new Error(`Unsafe path ${file.path}`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.data);
    }
    await mkdir(staging, { recursive: true });
    await rename(dir, old).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(staging, dir);
  } finally {
    await Promise.all([rm(staging, { recursive: true, force: true }), rm(old, { recursive: true, force: true })]);
  }
}

/**
 * Publishes a copy of files as a static preview. With `previewId`, the copy replaces that preview's
 * (same link, expiry renewed); it must be a static preview of the same owner.
 */
export async function publishStaticPreview(
  input: {
    owner: PreviewOwner;
    workspaceKey: string;
    files: SnapshotFile[];
    entry: string;
    title: string;
    public: boolean;
    previewId?: string | null;
  } & CreatedBy,
): Promise<Preview> {
  if (input.previewId) {
    const [existing] = await db
      .select()
      .from(previews)
      .where(and(eq(previews.id, input.previewId), ownerCondition(input.owner), eq(previews.kind, "static")));
    if (!existing) throw new UserError("previews.errors.notFound");
    await writeCopy(existing.id, input.files);
    const [row] = await db
      .update(previews)
      .set({ title: input.title, entry: input.entry, public: input.public, expiresAt: await expiry("static") })
      .where(eq(previews.id, existing.id))
      .returning();
    await auditPreview("preview.updated", row!, input.agentId);
    return row!;
  }
  const [row] = await db
    .insert(previews)
    .values({
      host: newHost(),
      kind: "static",
      title: input.title,
      ...ownerColumns(input.owner),
      workspaceKey: input.workspaceKey,
      entry: input.entry,
      public: input.public,
      expiresAt: await expiry("static"),
      agentId: input.agentId,
      runId: input.runId,
    })
    .returning();
  try {
    await writeCopy(row!.id, input.files);
  } catch (error) {
    await db.delete(previews).where(eq(previews.id, row!.id));
    throw error;
  }
  await auditPreview("preview.created", row!, input.agentId);
  return row!;
}

const active = () => gt(previews.expiresAt, new Date());

/** Active previews, newest first: of one owner, or all. */
export function listPreviews(owner?: PreviewOwner): Promise<Preview[]> {
  return db
    .select()
    .from(previews)
    .where(owner ? and(active(), ownerCondition(owner)) : active())
    .orderBy(desc(previews.createdAt));
}

export async function getPreview(id: string): Promise<Preview | null> {
  const [row] = await db.select().from(previews).where(eq(previews.id, id));
  return row ?? null;
}

/** The preview a host serves, unless it expired. */
export async function previewByHost(host: string): Promise<Preview | null> {
  const [row] = await db
    .select()
    .from(previews)
    .where(and(eq(previews.host, host), active()));
  return row ?? null;
}

async function activePreview(id: string): Promise<Preview> {
  const [row] = await db
    .select()
    .from(previews)
    .where(and(eq(previews.id, id), active()));
  if (!row) throw new UserError("previews.errors.notFound");
  return row;
}

export async function setPreviewPublic(id: string, isPublic: boolean, opts: { actor?: string } = {}): Promise<Preview> {
  await activePreview(id);
  const [row] = await db.update(previews).set({ public: isPublic }).where(eq(previews.id, id)).returning();
  await audit({
    actor: opts.actor ?? "user",
    action: isPublic ? "preview.made-public" : "preview.made-private",
    entityType: "preview",
    entityId: id,
    data: { title: row!.title },
  });
  return row!;
}

/** Gives the preview its full lifetime again, from now. */
export async function extendPreview(id: string): Promise<Preview> {
  const preview = await activePreview(id);
  const [row] = await db
    .update(previews)
    .set({ expiresAt: await expiry(preview.kind) })
    .where(eq(previews.id, id))
    .returning();
  return row!;
}

/** Takes the preview down at once: the link stops working and a static copy is deleted. */
export async function revokePreview(id: string, opts: { actor?: string } = {}): Promise<void> {
  const [row] = await db.delete(previews).where(eq(previews.id, id)).returning();
  if (!row) throw new UserError("previews.errors.notFound");
  await rm(previewDir(row.id), { recursive: true, force: true });
  await audit({
    actor: opts.actor ?? "user",
    action: "preview.revoked",
    entityType: "preview",
    entityId: id,
    data: { title: row.title },
  });
}

/** Deletes expired previews and copies left without a preview (an owner deleted). */
export async function sweepPreviews(now = new Date()): Promise<number> {
  const expired = await db.delete(previews).where(lte(previews.expiresAt, now)).returning({ id: previews.id });
  const root = resolveUpload(PREVIEWS_DIR);
  const names = root ? await readdir(root).catch(() => [] as string[]) : [];
  // Copies being written (.new-, .old-) belong to a publish in progress.
  const ids = names.filter((name) => /^[0-9a-f-]{36}$/.test(name));
  const known = new Set(
    ids.length
      ? (await db.select({ id: previews.id }).from(previews).where(inArray(previews.id, ids))).map((r) => r.id)
      : [],
  );
  const gone = ids.filter((id) => !known.has(id));
  await Promise.all(gone.map((id) => rm(previewDir(id), { recursive: true, force: true })));
  return expired.length;
}

async function auditPreview(action: "preview.created" | "preview.updated", preview: Preview, agentId: string | null) {
  await audit({
    actor: agentId ? `agent:${agentId}` : "user",
    action,
    entityType: "preview",
    entityId: preview.id,
    data: { title: preview.title, kind: preview.kind, public: preview.public },
  });
}

// ─── Access ───

let signingKey: Buffer | undefined;

/** A key of its own, derived from the vault key, so preview values sign nothing else. */
function key(): Buffer {
  signingKey ??= Buffer.from(hkdfSync("sha256", env().VAULT_KEY, "", "abotica preview access", 32));
  return signingKey;
}

const sign = (payload: string) => createHmac("sha256", key()).update(payload).digest("base64url");

function verified(value: string, parts: number): string[] | null {
  const pieces = value.split(".");
  if (pieces.length !== parts + 1) return null;
  const signature = Buffer.from(pieces.pop()!);
  const expected = Buffer.from(sign(pieces.join(".")));
  return signature.length === expected.length && timingSafeEqual(signature, expected) ? pieces : null;
}

/** A one-time pass to a preview, for the app to put in the link it redirects to. */
export function issuePreviewTicket(previewId: string, now = Date.now()): string {
  const payload = `${previewId}.${now + TICKET_TTL_MS}.${randomBytes(12).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * Whether a ticket opens this preview: false when it is forged, expired, used already or for
 * another preview. Redeeming it marks it used.
 */
export async function redeemPreviewTicket(ticket: string, previewId: string, now = Date.now()): Promise<boolean> {
  const parts = verified(ticket, 3);
  if (!parts || parts[0] !== previewId || Number(parts[1]) < now) return false;
  const fresh = await redis().set(`${TICKET_USED_KEY}${parts[2]}`, "1", "PX", TICKET_TTL_MS * 2, "NX");
  return fresh === "OK";
}

/** Value and lifetime of the cookie that grants a visitor a private preview. */
export function previewCookie(preview: Pick<Preview, "id" | "expiresAt">, now = Date.now()) {
  const expires = Math.min(preview.expiresAt.getTime(), now + COOKIE_MAX_MS);
  const payload = `${preview.id}.${expires}`;
  return { value: `${payload}.${sign(payload)}`, maxAgeSeconds: Math.max(0, Math.floor((expires - now) / 1000)) };
}

export function validPreviewCookie(value: string | undefined, previewId: string, now = Date.now()): boolean {
  const parts = value ? verified(value, 2) : null;
  return !!parts && parts[0] === previewId && Number(parts[1]) > now;
}

/** Name of that cookie: `__Host-` over HTTPS, so nothing else can set it. */
export const previewCookieName = () => (previewsSecure() ? "__Host-abotica_preview" : "abotica_preview");
