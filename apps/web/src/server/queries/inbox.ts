import "server-only";
import { listWaitingForUser, type WaitingItem } from "@abotica/core";
import { agents, approvals, db, projects, taskComments, tasks } from "@abotica/db";
import { eq, inArray } from "@abotica/db/orm";
import { query } from "@/server/query";

/** Project names by id, for the items' subtitles. */
async function projectNames(items: WaitingItem[]): Promise<Map<string, string>> {
  const ids = [...new Set(items.flatMap((i) => (i.projectId ? [i.projectId] : [])))];
  if (!ids.length) return new Map();
  const rows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, ids));
  return new Map(rows.map((p) => [p.id, p.name]));
}

const idsOf = (items: WaitingItem[], ...kinds: WaitingItem["kind"][]) =>
  items.filter((i) => kinds.includes(i.kind)).map((i) => i.id);

/** How many things wait for the user: the nav's Inbox badge. */
export const getInboxCount = query(async (): Promise<number> => (await listWaitingForUser()).length);

/** The first few things waiting for the user, oldest first, with their project: the dashboard's card. */
export const getInboxPreview = query(async (limit: number) => {
  const items = await listWaitingForUser();
  const names = await projectNames(items);
  return {
    total: items.length,
    items: items.slice(0, limit).map((i) => ({ ...i, projectName: i.projectId ? (names.get(i.projectId) ?? null) : null })),
  };
});

/** Everything waiting for the user, by kind, with what each row shows and needs to act on it. */
export const getInbox = query(async () => {
  const items = await listWaitingForUser();
  const questionIds = idsOf(items, "question");
  const taskIds = idsOf(items, "task", "blocked");
  const approvalIds = idsOf(items, "approval");
  const [names, questionRows, taskRows, approvalRows] = await Promise.all([
    projectNames(items),
    questionIds.length
      ? db
          .select({
            id: taskComments.id,
            body: taskComments.body,
            options: taskComments.options,
            taskTitle: tasks.title,
            askerName: agents.name,
            askerAvatar: agents.avatar,
          })
          .from(taskComments)
          .innerJoin(tasks, eq(tasks.id, taskComments.taskId))
          .leftJoin(agents, eq(agents.id, taskComments.authorAgentId))
          .where(inArray(taskComments.id, questionIds))
      : [],
    taskIds.length
      ? db
          .select({
            id: tasks.id,
            status: tasks.status,
            priority: tasks.priority,
            agentName: agents.name,
            agentAvatar: agents.avatar,
          })
          .from(tasks)
          .leftJoin(agents, eq(agents.id, tasks.assigneeAgentId))
          .where(inArray(tasks.id, taskIds))
      : [],
    approvalIds.length
      ? db
          .select({
            id: approvals.id,
            runId: approvals.runId,
            toolName: approvals.toolName,
            agentName: agents.name,
            agentAvatar: agents.avatar,
          })
          .from(approvals)
          .innerJoin(agents, eq(agents.id, approvals.agentId))
          .where(inArray(approvals.id, approvalIds))
      : [],
  ]);
  const project = (i: WaitingItem) => (i.projectId ? (names.get(i.projectId) ?? null) : null);
  const questions = new Map(questionRows.map((q) => [q.id, q]));
  const taskDetails = new Map(taskRows.map((t) => [t.id, t]));
  const approvalDetails = new Map(approvalRows.map((a) => [a.id, a]));

  const byKind = <K extends WaitingItem["kind"], T>(kind: K, detail: (id: string) => T | undefined) =>
    items.flatMap((i) => {
      const d = i.kind === kind ? detail(i.id) : undefined;
      return d ? [{ ...i, projectName: project(i), ...d }] : [];
    });

  return {
    total: items.length,
    questions: byKind("question", (id) => questions.get(id)).map((q) => ({ ...q, taskId: q.taskId! })),
    approvals: byKind("approval", (id) => approvalDetails.get(id)),
    tasks: byKind("task", (id) => taskDetails.get(id)),
    blocked: byKind("blocked", (id) => taskDetails.get(id)),
  };
});

export type Inbox = Awaited<ReturnType<typeof getInbox>>;
export type InboxQuestion = Inbox["questions"][number];
export type InboxTask = Inbox["tasks"][number];
export type InboxApproval = Inbox["approvals"][number];
export type InboxPreview = Awaited<ReturnType<typeof getInboxPreview>>;
