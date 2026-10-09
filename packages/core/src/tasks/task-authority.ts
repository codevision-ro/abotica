/** Who decides on a task besides its assignee: the agent that delegated it and its project's manager. */
import { db, projects, runs } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import type { Task } from "./tasks";

/** The agent whose run delegated the task, if any. */
export async function delegatorAgentId(task: Task): Promise<string | null> {
  if (!task.delegatedByRunId) return null;
  const [run] = await db.select({ agentId: runs.agentId }).from(runs).where(eq(runs.id, task.delegatedByRunId));
  return run?.agentId ?? null;
}

export async function taskAuthority(task: Task) {
  const [delegator, [project]] = await Promise.all([
    delegatorAgentId(task),
    task.projectId
      ? db.select({ managerAgentId: projects.managerAgentId }).from(projects).where(eq(projects.id, task.projectId))
      : Promise.resolve([]),
  ]);
  return { delegatorAgentId: delegator, projectManagerId: project?.managerAgentId ?? null };
}
