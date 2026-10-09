/**
 * Everything that waits for the user, in one list: pending approvals, questions that reached them, tasks
 * assigned to them, and blocked tasks with no agent above them. Reminders bring it up again every
 * reminderHours (Settings, reports).
 */
import { agents, approvals, db, projects, runs, taskComments, taskEvents, tasks, type Tx } from "@abotica/db";
import { and, eq, inArray, isNull, notInArray, sql } from "@abotica/db/orm";
import { getTranslator, type Translator } from "@abotica/i18n";
import { env } from "../infra/env";
import { notify } from "../infra/queues";
import { getSettings, settingsLocale } from "../settings/settings";

/** One thing waiting for the user, with what it is about and since when. */
export type WaitingItem = {
  kind: "approval" | "question" | "task" | "blocked";
  /** The approval's, the question's (task comment) or the task's id, by kind. */
  id: string;
  title: string;
  taskId: string | null;
  projectId: string | null;
  since: Date;
};

/** An item and when the user was last reminded of it (null: never). */
type Tracked = WaitingItem & { remindedAt: Date | null };

type Queryable = typeof db | Tx;

/** Task event that marks a task the user was reminded of: tasks have no reminded_at of their own. */
const REMINDED_EVENT = "user-reminded";
/** Characters of a question kept as its title. */
const TITLE_CHARS = 200;

const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS)}…` : line;
};

async function trackedItems(q: Queryable): Promise<Tracked[]> {
  // Columns named in full: in the field list of a single-table select drizzle leaves the table out, and an
  // unqualified "id" inside the subquery would be the event's own.
  const remindedAt = sql<Date | null>`(select max(e.created_at) from ${taskEvents} e
    where e.task_id = ${tasks}.${sql.identifier(tasks.id.name)} and e.type = ${REMINDED_EVENT})`.mapWith(
    (v: string | Date | null) => (v ? new Date(v) : null),
  );
  const taskColumns = {
    id: tasks.id,
    title: tasks.title,
    projectId: tasks.projectId,
    since: tasks.activityAt,
    remindedAt,
  };
  const [approvalRows, questionRows, assignedRows, blockedRows] = await Promise.all([
    q
      .select({
        id: approvals.id,
        tool: approvals.toolName,
        agent: agents.name,
        taskId: runs.taskId,
        projectId: runs.projectId,
        since: approvals.createdAt,
        remindedAt: approvals.remindedAt,
      })
      .from(approvals)
      .innerJoin(agents, eq(agents.id, approvals.agentId))
      .innerJoin(runs, eq(runs.id, approvals.runId))
      .where(eq(approvals.status, "pending")),
    q
      .select({
        id: taskComments.id,
        body: taskComments.body,
        taskId: taskComments.taskId,
        projectId: tasks.projectId,
        since: taskComments.createdAt,
        remindedAt: taskComments.remindedAt,
      })
      .from(taskComments)
      .innerJoin(tasks, eq(tasks.id, taskComments.taskId))
      .where(
        and(
          eq(taskComments.kind, "question"),
          eq(taskComments.questionStatus, "open"),
          eq(taskComments.addressedToUser, true),
        ),
      ),
    q
      .select(taskColumns)
      .from(tasks)
      .where(and(eq(tasks.assignedToUser, true), notInArray(tasks.status, ["done", "cancelled"]))),
    // No agent gave the task (no delegating run, not reported up by an automation): its superior is the user.
    q
      .select(taskColumns)
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "blocked"),
          eq(tasks.assignedToUser, false),
          isNull(tasks.delegatedByRunId),
          eq(tasks.reportsUp, false),
        ),
      ),
  ]);
  const items: Tracked[] = [
    ...approvalRows.map((a) => ({
      kind: "approval" as const,
      id: a.id,
      title: `${a.agent}: ${a.tool}`,
      taskId: a.taskId,
      projectId: a.projectId,
      since: a.since,
      remindedAt: a.remindedAt,
    })),
    ...questionRows.map((c) => ({
      kind: "question" as const,
      id: c.id,
      title: firstLine(c.body),
      taskId: c.taskId,
      projectId: c.projectId,
      since: c.since,
      remindedAt: c.remindedAt,
    })),
    ...assignedRows.map((t) => ({ kind: "task" as const, ...t, taskId: t.id })),
    ...blockedRows.map((t) => ({ kind: "blocked" as const, ...t, taskId: t.id })),
  ];
  return items.sort((a, b) => a.since.getTime() - b.since.getTime());
}

/** What waits for the user now, oldest first. */
export async function listWaitingForUser(): Promise<WaitingItem[]> {
  return (await trackedItems(db)).map(({ kind, id, title, taskId, projectId, since }) => ({
    kind,
    id,
    title,
    taskId,
    projectId,
    since,
  }));
}

/**
 * Whether the item is due for a reminder: it waited `hours` already and was not brought up in the last
 * `hours`. Never with reminders off (0 hours).
 */
export function dueForReminder(item: { since: Date; remindedAt: Date | null }, now: Date, hours: number): boolean {
  if (hours <= 0) return false;
  const cutoff = now.getTime() - hours * 3_600_000;
  return item.since.getTime() <= cutoff && (!item.remindedAt || item.remindedAt.getTime() <= cutoff);
}

/** How long something has waited, short: minutes under an hour, hours under two days, then days. */
export function waitingAge(t: Translator, since: Date, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
  if (minutes < 60) return t("inbox.age.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t("inbox.age.hours", { count: hours });
  return t("inbox.age.days", { count: Math.floor(hours / 24) });
}

/** One line per item: what it is, its title, its project and its age. */
export function waitingLines(
  t: Translator,
  items: WaitingItem[],
  projectNames: Map<string, string>,
  now: Date = new Date(),
): string[] {
  return items.map((item) => {
    const project = item.projectId ? projectNames.get(item.projectId) : undefined;
    const parts = [`${t(`inbox.kinds.${item.kind}`)}: ${item.title}`, project, waitingAge(t, item.since, now)];
    return `• ${parts.filter(Boolean).join(" · ")}`;
  });
}

/**
 * The list as one message (Markdown, for Telegram): a title with the count, a line per item and a link to
 * the inbox. `title` picks the reminder's or the /waiting command's heading.
 */
export async function waitingMessage(
  items: WaitingItem[],
  opts: { title: "reminder" | "list"; now?: Date },
): Promise<string> {
  const t = getTranslator(settingsLocale(await getSettings()));
  const projectIds = [...new Set(items.flatMap((i) => (i.projectId ? [i.projectId] : [])))];
  const rows = projectIds.length
    ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))
    : [];
  const lines = waitingLines(t, items, new Map(rows.map((p) => [p.id, p.name])), opts.now);
  const link = `[${t("inbox.reminder.open")}](${new URL("/inbox", env().APP_URL)})`;
  return [t(`inbox.reminder.${opts.title}`, { count: items.length }), "", ...lines, "", link].join("\n");
}

/**
 * Sends one notification listing what has waited longer than reminderHours and was not brought up within
 * them, then marks those reminded. Returns how many items it listed.
 */
export async function sendWaitingReminders(now: Date = new Date()): Promise<number> {
  const hours = (await getSettings()).reports.reminderHours;
  if (hours <= 0) return 0;
  // One sweep at a time: a second one waits for the lock, then finds everything marked.
  const due = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('waiting-reminders'))`);
    const items = (await trackedItems(tx)).filter((item) => dueForReminder(item, now, hours));
    const ids = (kind: WaitingItem["kind"]) => items.filter((i) => i.kind === kind).map((i) => i.id);
    const approvalIds = ids("approval");
    const questionIds = ids("question");
    const taskIds = [...ids("task"), ...ids("blocked")];
    if (approvalIds.length) await tx.update(approvals).set({ remindedAt: now }).where(inArray(approvals.id, approvalIds));
    if (questionIds.length) {
      await tx.update(taskComments).set({ remindedAt: now }).where(inArray(taskComments.id, questionIds));
    }
    if (taskIds.length) {
      await tx
        .insert(taskEvents)
        .values(taskIds.map((taskId) => ({ taskId, type: REMINDED_EVENT, actor: "system", data: {}, createdAt: now })));
    }
    return items;
  });
  if (!due.length) return 0;
  await notify({ kind: "text", text: await waitingMessage(due, { title: "reminder", now }) });
  return due.length;
}
