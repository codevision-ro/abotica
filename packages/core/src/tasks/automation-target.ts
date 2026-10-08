import { agents, db, projects } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { getOrchestrator } from "../runs/runs";
import { type ReportTarget, reportTargetOf } from "./automation-rules";

type Agent = typeof agents.$inferSelect;

/**
 * The agent the result of work a schedule or trigger fired goes to, decided when it is reported (a
 * manager disabled meanwhile is passed over): the project's manager for a specialist, the super agent
 * otherwise. Null when nobody is above the assignee, or the task has none.
 */
export async function reportTargetAgent(task: {
  assigneeAgentId: string | null;
  projectId: string | null;
}): Promise<{ agent: Agent; target: ReportTarget } | null> {
  if (!task.assigneeAgentId) return null;
  const [[assignee], [project]] = await Promise.all([
    db.select({ id: agents.id, kind: agents.kind }).from(agents).where(eq(agents.id, task.assigneeAgentId)),
    task.projectId
      ? db
          .select({ manager: agents })
          .from(projects)
          .innerJoin(agents, eq(agents.id, projects.managerAgentId))
          .where(eq(projects.id, task.projectId))
      : Promise.resolve([]),
  ]);
  if (!assignee) return null;
  const manager = project?.manager ?? null;
  const target = reportTargetOf(assignee, manager);
  if (!target) return null;
  return { agent: target === "manager" ? manager! : await getOrchestrator(), target };
}
