import { agentSkills, db, projectAgents, projectSkills, skills } from "@abotica/db";
import { and, eq, inArray, or } from "@abotica/db/orm";
import type { RunContext } from "../agents/context";

type SkillReader = Pick<RunContext, "agent" | "skills" | "managedProjectIds">;

/**
 * The skills an agent may read with skill_read, beyond the ones it uses (its own and its project's):
 * - the super agent: every skill of the platform, since it decides who gets which and briefs managers on work
 *   that uses them;
 * - a manager: the skills of the projects it leads and of the specialists on their teams, since it briefs and
 *   reviews their work;
 * - a specialist: none.
 * Reading is not using: a skill read this way is not in the agent's skill list and changes nothing it does.
 */
export async function findReadableSkill(reader: SkillReader, slug: string): Promise<{ id: string } | null> {
  const own = reader.skills.find((s) => s.slug === slug);
  if (own) return own;
  const { kind } = reader.agent;
  if (kind === "orchestrator") {
    const [skill] = await db.select({ id: skills.id }).from(skills).where(eq(skills.slug, slug));
    return skill ?? null;
  }
  if (kind !== "manager" || !reader.managedProjectIds.length) return null;
  const led = reader.managedProjectIds;
  const team = db.select({ id: projectAgents.agentId }).from(projectAgents).where(inArray(projectAgents.projectId, led));
  const [skill] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        eq(skills.slug, slug),
        or(
          inArray(
            skills.id,
            db.select({ id: projectSkills.skillId }).from(projectSkills).where(inArray(projectSkills.projectId, led)),
          ),
          inArray(
            skills.id,
            db.select({ id: agentSkills.skillId }).from(agentSkills).where(inArray(agentSkills.agentId, team)),
          ),
        ),
      ),
    )
    .limit(1);
  return skill ?? null;
}

/**
 * Whether skill_read is offered: to an agent with skills, and to those who may read others' (see
 * findReadableSkill).
 */
export const readsSkills = (reader: SkillReader): boolean =>
  reader.skills.length > 0 ||
  reader.agent.kind === "orchestrator" ||
  (reader.agent.kind === "manager" && reader.managedProjectIds.length > 0);

/** What skill_read says it reads, by who reads. */
export function skillReadDescription(reader: SkillReader): string {
  const files =
    "Without a path it returns SKILL.md and the list of the skill's other files; with a path (e.g. references/api.md) it returns that file.";
  if (reader.agent.kind === "orchestrator") {
    return `Read a skill: one of yours, or any skill of the platform (registry_list lists them), to know what it teaches before you assign it or brief work around it; its description is only a summary. ${files}`;
  }
  if (reader.agent.kind === "manager" && reader.managedProjectIds.length) {
    return `Read a skill: one of yours, or one of your projects' and your specialists' (listed with your team), to know what it teaches before you brief or review work around it. ${files}`;
  }
  return `Load a skill from your skill list. ${files}`;
}
