/**
 * Between dependent tasks: the files a done task produced go to the tasks waiting on it before they
 * start, and the delegators of tasks that cannot start (their dependency is blocked or cancelled) hear
 * about it.
 */
import { db, files, runs, taskComments, taskDependencies, taskEvents, tasks } from "@abotica/db";
import { and, asc, desc, eq, inArray, notInArray, sql } from "@abotica/db/orm";
import { newMarkerId } from "../agents/untrusted-id";
import { neutralizeMarkers, wrapUntrusted } from "../agents/untrusted";
import { deleteFile, readFileBytes, saveFile, type StoredFile } from "../files/files";
import { FILE_MAX_BYTES } from "../platform/limits";
import { deliverToSuperior } from "../runs/deliver";
import type { Task, TaskStatus } from "./tasks";

/** Who notices come from, as people read it. */
const FROM = "Abotica";
/** How much of a dependency's last comment an alert quotes as the reason. */
const REASON_LIMIT = 500;

/**
 * What a task produced: the files its own runs stored for it (files a delegator handed over were stored
 * by the delegating run, as in the delegation report). The latest of each name, since a later run
 * replaces an earlier version of the same file.
 */
async function producedFiles(taskId: string): Promise<(StoredFile & { producerAgentId: string | null })[]> {
  const rows = await db
    .select({ file: files, agentId: runs.agentId })
    .from(files)
    .innerJoin(runs, and(eq(runs.id, files.runId), eq(runs.taskId, files.taskId)))
    .where(eq(files.taskId, taskId))
    .orderBy(asc(files.createdAt));
  const latest = new Map<string, StoredFile & { producerAgentId: string | null }>();
  for (const { file, agentId } of rows) latest.set(file.name, { ...file, producerAgentId: file.agentId ?? agentId });
  return [...latest.values()];
}

/**
 * Copies the files the done task's own runs produced to every task that depends on it and is still open,
 * before those start: the dependent's brief lists its files. Each copy keeps the producing run and agent,
 * so it counts as handed over, not as the dependent's own work; an earlier copy of the same name from this
 * task is replaced. A `handoff` event on the dependent lists them. Returns how many files were copied.
 */
export async function handOffFiles(doneTaskId: string): Promise<number> {
  const dependents = await db
    .select({ id: tasks.id })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
    .where(and(eq(taskDependencies.dependsOnTaskId, doneTaskId), notInArray(tasks.status, ["done", "cancelled"])));
  if (!dependents.length) return 0;
  const produced = (await producedFiles(doneTaskId)).filter((f) => f.size <= FILE_MAX_BYTES);
  if (!produced.length) return 0;
  const producingRuns = db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, doneTaskId));

  let copied = 0;
  for (const dependent of dependents) {
    const earlier = await db
      .select({ id: files.id, name: files.name })
      .from(files)
      .where(
        and(
          eq(files.taskId, dependent.id),
          inArray(files.runId, producingRuns),
          inArray(
            files.name,
            produced.map((f) => f.name),
          ),
        ),
      );
    const handed: string[] = [];
    for (const file of produced) {
      // Bytes gone from the disk leave nothing to copy; the rest still goes.
      const data = await readFileBytes(file.id);
      if (!data) continue;
      await saveFile({
        name: file.name,
        data,
        source: "agent",
        owner: { taskId: dependent.id },
        mimeType: file.mimeType,
        runId: file.runId,
        agentId: file.producerAgentId,
      });
      for (const old of earlier.filter((e) => e.name === file.name)) await deleteFile(old.id);
      handed.push(file.name);
    }
    if (!handed.length) continue;
    copied += handed.length;
    await db.insert(taskEvents).values({
      taskId: dependent.id,
      type: "handoff",
      actor: "system",
      data: { fromTaskId: doneTaskId, files: handed },
    });
  }
  return copied;
}

/** The conversation each task's delegator gave it from; missing for a task no run delegated. */
async function delegatingConversations(taskIds: string[]): Promise<Map<string, string | null>> {
  const rows = await db
    .select({ id: tasks.id, conversationId: runs.conversationId })
    .from(tasks)
    .innerJoin(runs, eq(runs.id, tasks.delegatedByRunId))
    .where(inArray(tasks.id, taskIds));
  return new Map(rows.map((r) => [r.id, r.conversationId]));
}

/** Why the dependency stopped, from its latest comment (the agent's or the platform's); null without one. */
async function lastComment(taskId: string): Promise<string | null> {
  const [comment] = await db
    .select({ body: taskComments.body })
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(desc(taskComments.createdAt))
    .limit(1);
  return comment?.body ?? null;
}

/** The alert to the delegator of `waiting`, which cannot start because `dependency` stopped. */
export function dependencyAlertText(
  dependency: Pick<Task, "id" | "title">,
  status: "blocked" | "cancelled",
  reason: string | null,
  waiting: Pick<Task, "id" | "title">[],
): string {
  const names = waiting.map((t) => `"${neutralizeMarkers(t.title)}" (${t.id})`).join(", ");
  return [
    `${waiting.length === 1 ? `Task ${names} cannot start` : `Tasks ${names} cannot start`}: ${waiting.length === 1 ? "it waits" : "they wait"} on "${neutralizeMarkers(dependency.title)}" (${dependency.id}), which is ${status}.`,
    reason
      ? `Its last comment, as written there:\n${wrapUntrusted(reason.slice(0, REASON_LIMIT), { source: "delegated-task", id: newMarkerId() })}`
      : null,
    status === "blocked"
      ? "Decide now: unblock it (answer it, give it back with what it needs), remove the dependency, or cancel the waiting work (task_control)."
      : "Decide now: remove the dependency so the work can start without it, have the cancelled part done another way, or cancel the waiting work (task_control).",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Tells the delegators of the tasks waiting on this one that they cannot start, now that it is blocked or
 * cancelled; once per dependent, dependency and status (a `dependency-alert` event on the dependent). A
 * dependent delegated from the same conversation as the dependency needs no alert: the dependency's own
 * report there names the tasks waiting on it. The others get one alert per conversation, which wakes it.
 */
export async function alertDependents(taskId: string, status: TaskStatus): Promise<void> {
  if (status !== "blocked" && status !== "cancelled") return;
  const [dependency] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!dependency) return;
  const waiting = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
    .where(and(eq(taskDependencies.dependsOnTaskId, taskId), eq(tasks.status, "backlog")));
  if (!waiting.length) return;
  const alerted = await db
    .select({ taskId: taskEvents.taskId })
    .from(taskEvents)
    .where(
      and(
        inArray(
          taskEvents.taskId,
          waiting.map((t) => t.id),
        ),
        eq(taskEvents.type, "dependency-alert"),
        sql`${taskEvents.data}->>'dependencyId' = ${taskId}`,
        sql`${taskEvents.data}->>'status' = ${status}`,
      ),
    );
  const fresh = waiting.filter((t) => !alerted.some((a) => a.taskId === t.id));
  if (!fresh.length) return;

  const conversations = await delegatingConversations([taskId, ...fresh.map((t) => t.id)]);
  const own = conversations.get(taskId) ?? null;
  const groups = new Map<string | null, typeof fresh>();
  for (const dependent of fresh) {
    const conversationId = conversations.get(dependent.id) ?? null;
    await db.insert(taskEvents).values({
      taskId: dependent.id,
      type: "dependency-alert",
      actor: "system",
      data: { dependencyId: taskId, status, inReport: conversationId === own },
    });
    if (conversationId === own) continue;
    groups.set(conversationId, [...(groups.get(conversationId) ?? []), dependent]);
  }
  if (!groups.size) return;
  const reason = await lastComment(taskId);
  for (const group of groups.values()) {
    const text = dependencyAlertText(dependency, status, reason, group);
    await deliverToSuperior(group[0]!.id, { kind: "alert", text, from: FROM }, { wake: "now" });
  }
}
