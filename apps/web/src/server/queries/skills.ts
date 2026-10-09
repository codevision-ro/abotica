import "server-only";
import { changedSkillFields, compareSkillPaths, diffSkillFiles, isSkillModified } from "@abotica/core";
import {
  type AgentAvatar,
  agentSkills,
  agents,
  db,
  projects,
  projectSkills,
  skillFiles,
  skills,
  skillVersions,
} from "@abotica/db";
import { asc, count, desc, eq, ne } from "@abotica/db/orm";
import { query } from "@/server/query";

type AssignTarget = { id: string; name: string; hint: string; avatar?: AgentAvatar };

/** Agents and projects that can receive skills or MCP servers. Templates and archived projects are left out. */
export const getAssignTargets = query(async (): Promise<{ agents: AssignTarget[]; projects: AssignTarget[] }> => {
  const [agentRows, projectRows] = await Promise.all([
    db
      .select({ id: agents.id, name: agents.name, avatar: agents.avatar, slug: agents.slug })
      .from(agents)
      .where(eq(agents.isTemplate, false))
      .orderBy(asc(agents.name)),
    db
      .select({ id: projects.id, name: projects.name, slug: projects.slug })
      .from(projects)
      .where(ne(projects.status, "archived"))
      .orderBy(asc(projects.name)),
  ]);
  return {
    agents: agentRows.map((a) => ({ id: a.id, name: a.name, hint: a.slug, avatar: a.avatar })),
    projects: projectRows.map((p) => ({ id: p.id, name: p.name, hint: p.slug })),
  };
});

export const listSkills = query(async () => {
  const [rows, agentCounts, projectCounts, fileCounts] = await Promise.all([
    db.select().from(skills).orderBy(asc(skills.name)),
    db.select({ id: agentSkills.skillId, n: count() }).from(agentSkills).groupBy(agentSkills.skillId),
    db.select({ id: projectSkills.skillId, n: count() }).from(projectSkills).groupBy(projectSkills.skillId),
    db.select({ id: skillFiles.skillId, n: count() }).from(skillFiles).groupBy(skillFiles.skillId),
  ]);
  const a = new Map(agentCounts.map((r) => [r.id, r.n]));
  const p = new Map(projectCounts.map((r) => [r.id, r.n]));
  const f = new Map(fileCounts.map((r) => [r.id, r.n]));
  return rows.map((s) => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    enabled: s.enabled,
    version: s.version,
    source: s.source,
    updatedAt: s.updatedAt,
    agentCount: a.get(s.id) ?? 0,
    projectCount: p.get(s.id) ?? 0,
    fileCount: f.get(s.id) ?? 0,
  }));
});

export type SkillListItem = Awaited<ReturnType<typeof listSkills>>[number];

/** Source ids ("owner/repo/skill" for skills.sh, "owner/repo:path" for GitHub) of installed skills, to mark them in search results. */
export const listInstalledSources = query(async (): Promise<Record<string, string>> => {
  const rows = await db.select({ id: skills.id, source: skills.source }).from(skills);
  return Object.fromEntries(
    rows.flatMap((r) =>
      r.source ? [[r.source.kind === "skills.sh" ? r.source.id : `${r.source.repo}:${r.source.path}`, r.id]] : [],
    ),
  );
});

export const getSkill = query(async (id: string) => {
  const [skill] = await db.select().from(skills).where(eq(skills.id, id));
  if (!skill) return null;
  const [files, agentIds, projectIds] = await Promise.all([
    db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.skillId, id)),
    db.select({ id: agentSkills.agentId }).from(agentSkills).where(eq(agentSkills.skillId, id)),
    db.select({ id: projectSkills.projectId }).from(projectSkills).where(eq(projectSkills.skillId, id)),
  ]);
  files.sort((a, b) => compareSkillPaths(a.path, b.path));
  return {
    ...skill,
    files,
    agentIds: agentIds.map((r) => r.id),
    projectIds: projectIds.map((r) => r.id),
    /** Installed from a source and edited since. */
    modified: isSkillModified(skill, files),
  };
});

/** The skill's versions, newest first. */
const versionRows = (skillId: string) =>
  db.select().from(skillVersions).where(eq(skillVersions.skillId, skillId)).orderBy(desc(skillVersions.version));

/** Newest first, each with what changed compared to the version before it. */
export const listSkillVersions = query(async (skillId: string) => {
  const rows = await versionRows(skillId);
  return rows.map((row, i) => {
    const previous = rows[i + 1]?.snapshot;
    const files = previous ? diffSkillFiles(previous.files, row.snapshot.files) : [];
    return {
      version: row.version,
      note: row.note,
      createdAt: row.createdAt,
      fileCount: row.snapshot.files.length,
      changed: previous ? changedSkillFields(previous, row.snapshot) : [],
      files: files.map(({ path, status }) => ({ path, status })),
    };
  });
});

/** One version compared to the one before it (or to nothing, for the first). */
export const getSkillVersionDiff = query(async (skillId: string, version: number) => {
  const rows = await versionRows(skillId);
  const index = rows.findIndex((r) => r.version === version);
  if (index === -1) return null;
  const current = rows[index]!.snapshot;
  const previous = rows[index + 1]?.snapshot ?? { name: "", description: "", metadata: {}, files: [] };
  return {
    version,
    previousVersion: rows[index + 1]?.version ?? null,
    name: { before: previous.name, after: current.name },
    description: { before: previous.description, after: current.description },
    metadata: { before: previous.metadata ?? {}, after: current.metadata ?? {} },
    files: diffSkillFiles(previous.files, current.files),
  };
});
