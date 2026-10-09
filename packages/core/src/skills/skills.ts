import {
  agents,
  agentSkills,
  db,
  projects,
  projectSkills,
  type SkillOrigin,
  type SkillSnapshot,
  type SkillSource,
  skillFiles,
  skills,
  skillVersions,
  type Tx,
} from "@abotica/db";
import { and, asc, eq, inArray, like } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { audit } from "../platform/audit";
import { createConversation } from "../runs/conversations";
import { isUniqueViolation } from "../infra/db-errors";
import { startRun } from "../runs/runs";
import { settingsTranslator } from "../settings/settings";
import { checkSkillFiles, compareSkillPaths, SKILL_MD, type SkillFileEntry, type SkillPackage } from "./skill-md";
import { fetchSkill, fetchSourceHash, hashSkillPackage, type SkillSourceRef, sourceRef } from "./skill-sources";
import { slugify } from "../platform/slug";

/**
 * Skills with versioning: every change to the name, description, metadata or files stores a new
 * version that can be compared and restored. Slug, enabled flag and assignments are not versioned.
 */

export type Skill = typeof skills.$inferSelect;

type Assignments = { agentIds: string[]; projectIds: string[] };

type SkillChange = Partial<SkillPackage & Assignments & { slug: string; enabled: boolean }>;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function versionNotes() {
  const t = await settingsTranslator();
  return {
    initial: t("skills.versionNotes.initial"),
    installed: (url: string) => t("skills.versionNotes.installed", { url }),
    synced: (url: string) => t("skills.versionNotes.synced", { url }),
    restored: (version: number) => t("skills.versionNotes.restored", { version }),
  };
}

/** Sorted files, SKILL.md first; rejects folders the format or the limits do not allow. */
function validFiles(files: SkillFileEntry[]): SkillFileEntry[] {
  const sorted = [...files].sort((a, b) => compareSkillPaths(a.path, b.path));
  const problem = checkSkillFiles(sorted);
  if (problem) {
    const { code, ...values } = problem;
    throw new UserError(`skills.files.${code}`, values);
  }
  return sorted;
}

function validSlug(slug: string): string {
  if (!SLUG_RE.test(slug) || slug.length > 64) throw new UserError("skills.validation.slugFormat");
  return slug;
}

async function uniqueSkillSlug(tx: Tx, name: string): Promise<string> {
  const base = slugify(name, 48) || "skill";
  const taken = new Set(
    (
      await tx
        .select({ slug: skills.slug })
        .from(skills)
        .where(like(skills.slug, `${base}%`))
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

async function lockSkill(tx: Tx, id: string): Promise<Skill> {
  const [skill] = await tx.select().from(skills).where(eq(skills.id, id)).for("update");
  if (!skill) throw new UserError("skills.errors.notFound");
  return skill;
}

async function readFiles(tx: Tx | typeof db, skillId: string): Promise<SkillFileEntry[]> {
  const rows = await tx
    .select({ path: skillFiles.path, content: skillFiles.content })
    .from(skillFiles)
    .where(eq(skillFiles.skillId, skillId));
  return rows.sort((a, b) => compareSkillPaths(a.path, b.path));
}

async function writeFiles(tx: Tx, skillId: string, files: SkillFileEntry[]) {
  await tx.delete(skillFiles).where(eq(skillFiles.skillId, skillId));
  if (files.length) await tx.insert(skillFiles).values(files.map((f) => ({ skillId, ...f })));
}

async function replaceAssignments(tx: Tx, skillId: string, input: Partial<Assignments>) {
  if (input.agentIds) {
    const ids = input.agentIds.length
      ? (
          await tx
            .select({ id: agents.id })
            .from(agents)
            .where(inArray(agents.id, [...new Set(input.agentIds)]))
        ).map((r) => r.id)
      : [];
    await tx.delete(agentSkills).where(eq(agentSkills.skillId, skillId));
    if (ids.length) await tx.insert(agentSkills).values(ids.map((agentId) => ({ agentId, skillId })));
  }
  if (input.projectIds) {
    const ids = input.projectIds.length
      ? (
          await tx
            .select({ id: projects.id })
            .from(projects)
            .where(inArray(projects.id, [...new Set(input.projectIds)]))
        ).map((r) => r.id)
      : [];
    await tx.delete(projectSkills).where(eq(projectSkills.skillId, skillId));
    if (ids.length) await tx.insert(projectSkills).values(ids.map((projectId) => ({ projectId, skillId })));
  }
}

const snapshotOf = (skill: Pick<Skill, "name" | "description" | "metadata">, files: SkillFileEntry[]): SkillSnapshot => ({
  name: skill.name,
  description: skill.description,
  metadata: skill.metadata,
  files,
});

/** Which parts of the versioned content differ between two snapshots. */
export function changedSkillFields(a: SkillSnapshot, b: SkillSnapshot): ("name" | "description" | "metadata" | "files")[] {
  const fields = ["name", "description", "metadata", "files"] as const;
  return fields.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/** Per file: added, removed or changed between two snapshots. */
export function diffSkillFiles(before: SkillFileEntry[], after: SkillFileEntry[]) {
  const a = new Map(before.map((f) => [f.path, f.content]));
  const b = new Map(after.map((f) => [f.path, f.content]));
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort(compareSkillPaths);
  return paths.flatMap((path) => {
    const was = a.get(path);
    const now = b.get(path);
    if (was === now) return [];
    const status = was === undefined ? "added" : now === undefined ? "removed" : "changed";
    return [{ path, status, before: was ?? "", after: now ?? "" } as const];
  });
}

/** True when an installed skill no longer matches what came from its source. */
export function isSkillModified(
  skill: Pick<Skill, "name" | "description" | "metadata" | "source">,
  files: SkillFileEntry[],
) {
  return Boolean(skill.source) && hashSkillPackage({ ...skill, files }) !== skill.source!.contentHash;
}

export async function createSkill(
  input: SkillPackage & Partial<Assignments> & { slug?: string; enabled?: boolean },
  opts: { source?: SkillOrigin; note?: string; actor?: string } = {},
): Promise<Skill> {
  const files = validFiles(input.files);
  const notes = await versionNotes();
  const name = input.name.trim();
  if (!name) throw new UserError("skills.validation.nameRequired");
  try {
    const skill = await db.transaction(async (tx) => {
      const slug = input.slug ? validSlug(input.slug) : await uniqueSkillSlug(tx, name);
      const values = { name, description: input.description.trim(), metadata: input.metadata };
      const source = opts.source ? { ...opts.source, contentHash: hashSkillPackage({ ...values, files }) } : null;
      const [row] = await tx
        .insert(skills)
        .values({ ...values, slug, enabled: input.enabled ?? true, version: 1, source })
        .returning();
      await writeFiles(tx, row!.id, files);
      await replaceAssignments(tx, row!.id, input);
      await tx.insert(skillVersions).values({
        skillId: row!.id,
        version: 1,
        snapshot: snapshotOf(row!, files),
        note: opts.note ?? (opts.source ? notes.installed(opts.source.url) : notes.initial),
      });
      return row!;
    });
    await audit({
      actor: opts.actor ?? "user",
      action: opts.source ? "skill.installed" : "skill.created",
      entityType: "skill",
      entityId: skill.id,
      data: { slug: skill.slug, files: files.length, ...(opts.source && { source: opts.source.url }) },
    });
    return skill;
  } catch (error) {
    if (isUniqueViolation(error)) throw new UserError("skills.errors.slugTaken", { slug: input.slug ?? "" });
    throw error;
  }
}

/**
 * Applies a partial change; fields left out keep their value. A change to the versioned content
 * bumps the version and stores the new snapshot.
 */
export async function updateSkill(
  id: string,
  change: SkillChange,
  opts: {
    note?: string;
    source?: SkillSource | null;
    actor?: string;
    auditAction?: "skill.updated" | "skill.synced" | "skill.restored";
    auditData?: Record<string, unknown>;
  } = {},
): Promise<{ skill: Skill; version: number; changed: ReturnType<typeof changedSkillFields> }> {
  const files = change.files && validFiles(change.files);
  try {
    const result = await db.transaction(async (tx) => {
      const skill = await lockSkill(tx, id);
      const before = snapshotOf(skill, await readFiles(tx, id));
      const name = change.name?.trim() ?? skill.name;
      if (!name) throw new UserError("skills.validation.nameRequired");
      const after = snapshotOf(
        { name, description: change.description?.trim() ?? skill.description, metadata: change.metadata ?? skill.metadata },
        files ?? before.files,
      );
      const changed = changedSkillFields(before, after);
      const version = changed.length ? skill.version + 1 : skill.version;
      const [updated] = await tx
        .update(skills)
        .set({
          name: after.name,
          description: after.description,
          metadata: after.metadata,
          slug: change.slug === undefined ? skill.slug : validSlug(change.slug),
          enabled: change.enabled ?? skill.enabled,
          version,
          ...(opts.source !== undefined && { source: opts.source }),
        })
        .where(eq(skills.id, id))
        .returning();
      if (files && changed.includes("files")) await writeFiles(tx, id, files);
      await replaceAssignments(tx, id, change);
      if (changed.length) {
        await tx.insert(skillVersions).values({ skillId: id, version, snapshot: after, note: opts.note ?? "" });
      }
      return { skill: updated!, version, changed };
    });
    await audit({
      actor: opts.actor ?? "user",
      action: opts.auditAction ?? "skill.updated",
      entityType: "skill",
      entityId: id,
      data: { slug: result.skill.slug, version: result.version, changed: result.changed, ...opts.auditData },
    });
    return result;
  } catch (error) {
    if (isUniqueViolation(error)) throw new UserError("skills.errors.slugTaken", { slug: change.slug ?? "" });
    throw error;
  }
}

export async function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
  const [row] = await db.update(skills).set({ enabled }).where(eq(skills.id, id)).returning({ id: skills.id });
  if (!row) throw new UserError("skills.errors.notFound");
  await audit({ actor: "user", action: enabled ? "skill.enabled" : "skill.disabled", entityType: "skill", entityId: id });
}

export async function deleteSkill(id: string): Promise<void> {
  const [row] = await db.delete(skills).where(eq(skills.id, id)).returning({ slug: skills.slug });
  if (!row) throw new UserError("skills.errors.notFound");
  await audit({ actor: "user", action: "skill.deleted", entityType: "skill", entityId: id, data: { slug: row.slug } });
}

export async function restoreSkillVersion(id: string, version: number) {
  const [row] = await db
    .select({ snapshot: skillVersions.snapshot })
    .from(skillVersions)
    .where(and(eq(skillVersions.skillId, id), eq(skillVersions.version, version)));
  if (!row) throw new UserError("skills.errors.versionNotFound", { version });
  const notes = await versionNotes();
  const { name, description, metadata, files } = row.snapshot;
  return updateSkill(
    id,
    { name, description, metadata: metadata ?? {}, files },
    { note: notes.restored(version), auditAction: "skill.restored", auditData: { from: version } },
  );
}

/** Installs a skill from skills.sh or GitHub; `expectedHash` makes sure it is what the user previewed. */
export async function installSkill(ref: SkillSourceRef, opts: { expectedHash?: string; actor?: string } = {}) {
  const fetched = await fetchSkill(ref);
  if (opts.expectedHash && fetched.source.hash !== opts.expectedHash) throw new UserError("skills.errors.sourceChanged");
  return createSkill(fetched.pkg, { source: fetched.source, actor: opts.actor });
}

type SkillUpdateStatus = { updateAvailable: boolean; modified: boolean };

export async function checkSkillUpdate(id: string): Promise<SkillUpdateStatus> {
  const [skill] = await db.select().from(skills).where(eq(skills.id, id));
  if (!skill) throw new UserError("skills.errors.notFound");
  if (!skill.source) return { updateAvailable: false, modified: false };
  const files = await readFiles(db, id);
  return {
    updateAvailable: (await fetchSourceHash(skill.source)) !== skill.source.hash,
    modified: isSkillModified(skill, files),
  };
}

/** Replaces the skill's content with its source's current version (local edits are overwritten). */
export async function syncSkillFromSource(id: string) {
  const [skill] = await db.select().from(skills).where(eq(skills.id, id));
  if (!skill) throw new UserError("skills.errors.notFound");
  if (!skill.source) throw new UserError("skills.errors.noSource");
  const fetched = await fetchSkill(sourceRef(skill.source));
  const notes = await versionNotes();
  return updateSkill(id, fetched.pkg, {
    note: notes.synced(fetched.source.url),
    source: { ...fetched.source, contentHash: hashSkillPackage(fetched.pkg) },
    auditAction: "skill.synced",
    auditData: { source: fetched.source.url },
  });
}

/**
 * Opens a web conversation where the agent has this skill, assigned or not, and sends the prompt.
 * Returns the conversation id; the run shows up there live.
 */
export async function startSkillTest(input: { skillId: string; agentId: string; prompt: string }): Promise<string> {
  const [skill] = await db.select({ name: skills.name }).from(skills).where(eq(skills.id, input.skillId));
  if (!skill) throw new UserError("skills.errors.notFound");
  const t = await settingsTranslator();
  const conversation = await createConversation({
    agentId: input.agentId,
    channel: "web",
    title: t("skills.test.conversationTitle", { name: skill.name }),
    testSkillId: input.skillId,
  });
  await startRun({ agentId: input.agentId, trigger: "chat", conversationId: conversation.id, input: input.prompt });
  await audit({
    actor: "user",
    action: "skill.tested",
    entityType: "skill",
    entityId: input.skillId,
    data: { agentId: input.agentId, conversationId: conversation.id },
  });
  return conversation.id;
}

/** What `skill_read` returns: SKILL.md with the list of other files, or one file by path. */
export async function readSkillForAgent(skillId: string, path?: string) {
  const files = await db
    .select({ path: skillFiles.path, content: skillFiles.content })
    .from(skillFiles)
    .where(eq(skillFiles.skillId, skillId))
    .orderBy(asc(skillFiles.path));
  const wanted = path?.replace(/^\.\//, "") || SKILL_MD;
  const file = files.find((f) => f.path === wanted);
  const others = files
    .filter((f) => f.path !== SKILL_MD)
    .map((f) => f.path)
    .sort(compareSkillPaths);
  if (!file) return { error: `File ${wanted} does not exist in this skill`, files: [SKILL_MD, ...others] };
  if (wanted !== SKILL_MD) return { path: wanted, content: file.content };
  return { path: SKILL_MD, instructions: file.content, files: others };
}
