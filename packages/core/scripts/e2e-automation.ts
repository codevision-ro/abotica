import { agents, conversations, db, messages, runs, taskComments, tasks } from "@abotica/db";
import { and, asc, eq, gte, inArray } from "@abotica/db/orm";
import {
  createAgentFromTemplate,
  createProject,
  createSchedule,
  deleteConversation,
  deleteProject,
  deleteSchedule,
  getOrchestrator,
  getTelegramToken,
  isDelegationReport,
  runScheduleNow,
  telegramAccess,
  telegramConversationKey,
} from "../src/index";
import { isUserError } from "@abotica/i18n";
import { wait } from "./e2e-shared";

/**
 * End-to-end check of work a schedule fires for a specialist in a project with a manager: it runs as a
 * task that reports up on its own (tasks.reportsUp), the manager reviews it as a task of its own, and
 * the super agent gets the manager's result where the user talks to it. A second schedule whose result
 * needs nobody ends with nothingNew and reaches nobody. Needs the worker running.
 * With Telegram set up the super agent's answer goes to the notification chat: the script gives it a
 * fresh conversation there (as /new does) and removes it afterwards, so the user's own stays as it was.
 * Usage: pnpm --filter @abotica/core e2e:automation (E2E_PROVIDER and E2E_MODEL pick the model, default DeepSeek)
 */
const TIMEOUT_MS = 12 * 60_000;
const MODEL = { provider: process.env.E2E_PROVIDER ?? "deepseek", model: process.env.E2E_MODEL ?? "deepseek-v4-flash" };
const NEVER = new Date("2099-01-01T00:00:00Z");
const startedAt = new Date();
const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

const orchestrator = await getOrchestrator();
const createdAgents: string[] = [];
const createdProjects: string[] = [];
const createdSchedules: string[] = [];
const inboxes: string[] = [];

/** Throws as soon as a run of this test fails, instead of waiting for the timeout. */
async function assertNoFailedRun() {
  const [failed] = await db
    .select({ id: runs.id, error: runs.error })
    .from(runs)
    .where(and(gte(runs.createdAt, startedAt), eq(runs.status, "failed")))
    .limit(1);
  if (failed) throw new Error(`run ${failed.id} failed: ${failed.error ?? "no error recorded"}`);
}

async function until(label: string, done: () => Promise<boolean>) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!(await done())) {
    await assertNoFailedRun();
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${label}`);
    await wait(3000);
  }
}

const taskOf = async (scheduleId: string) =>
  db.select().from(tasks).where(eq(tasks.scheduleId, scheduleId)).orderBy(asc(tasks.createdAt));

const idle = async () =>
  !(
    await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(gte(runs.createdAt, startedAt), inArray(runs.status, ["queued", "running"])))
  ).length;

try {
  const specialist = await createAgentFromTemplate("template-software-engineer", { name: "E2E Software engineer" });
  createdAgents.push(specialist.id);
  const project = await createProject({
    name: `E2E Automation ${Date.now().toString(36)}`,
    description: "A small company website for a bakery called Crumb.",
    memberIds: [specialist.id],
  });
  createdProjects.push(project.id);
  const manager = project.managerAgentId!;
  createdAgents.push(manager);
  await db
    .update(agents)
    .set({ ...MODEL, fallbacks: [] })
    .where(inArray(agents.id, [manager, specialist.id]));

  // The super agent's inbox for this project: with Telegram, a fresh conversation of the chat it would use.
  const [{ notifyChatId }, token] = await Promise.all([telegramAccess(), getTelegramToken()]);
  const telegram = Boolean(token) && notifyChatId !== null;
  const [inbox] = await db
    .insert(conversations)
    .values({
      agentId: orchestrator.id,
      channel: telegram ? "telegram" : "web",
      externalId: telegram ? telegramConversationKey(notifyChatId!, null) : `reports:${project.id}`,
      projectId: null,
      title: "E2E automation inbox",
      modelOverride: MODEL,
    })
    .returning();
  inboxes.push(inbox!.id);
  console.log(`inbox ${inbox!.id} (${inbox!.channel})`);

  // 1. Work with a result: specialist -> manager -> super agent.
  const audit = await createSchedule({
    agentId: specialist.id,
    projectId: project.id,
    name: "E2E homepage title",
    kind: "once",
    runAt: NEVER,
    prompt:
      "Write the HTML <title> for the homepage of Crumb, an artisan bakery: one line, at most 60 characters. Put it in the task output.",
  });
  createdSchedules.push(audit.id);
  const first = await runScheduleNow(audit.id);
  check(first.agentId === specialist.id && first.trigger === "schedule", "the fire started the specialist's run");
  const [work] = await taskOf(audit.id);
  check(
    Boolean(work?.reportsUp) && work?.assigneeAgentId === specialist.id && work?.projectId === project.id,
    "the fire made a task that reports up, for the specialist, in the project",
  );
  const again = await runScheduleNow(audit.id).then(
    () => "started",
    (error: unknown) => (isUserError(error) ? error.key : String(error)),
  );
  check(again === "automations.errors.previousStillWorking", "Run now is refused while the previous task is worked on");

  await until("the super agent's answer", async () => {
    if (!(await idle())) return false;
    const answers = await db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(and(eq(runs.conversationId, inbox!.id), gte(runs.createdAt, startedAt)));
    return answers.length > 0 && answers.every((r) => r.status === "succeeded");
  });

  const rows = await taskOf(audit.id);
  const done = rows.find((t) => t.id === work!.id)!;
  const review = rows.find((t) => t.id !== work!.id);
  check(done.reportedAt !== null, "the specialist's task was reported");
  check(
    review?.assigneeAgentId === manager && review.reportsUp && done.parentId === review.id,
    "the manager reviewed it as a task of its own, with the work as its subtask",
  );
  check(review?.reportedAt !== null, "the manager's task was reported");
  const managerConversation = review
    ? (await db.select({ c: runs.conversationId }).from(runs).where(eq(runs.taskId, review.id)))[0]?.c
    : null;
  const managerNotice = managerConversation
    ? (await db.select().from(messages).where(eq(messages.conversationId, managerConversation))).find((m) =>
        isDelegationReport(m.metadata),
      )
    : null;
  check(Boolean(managerNotice), "the specialist's result reached the manager as a report");
  const inboxMessages = await db.select().from(messages).where(eq(messages.conversationId, inbox!.id));
  const superNotice = inboxMessages.find((m) => isDelegationReport(m.metadata));
  check(Boolean(superNotice), "the manager's result reached the super agent's inbox as a report");
  check(
    inboxMessages.some((m) => m.role === "assistant"),
    "the super agent answered in the inbox (where the user reads it)",
  );
  const elsewhere = await db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(conversations, eq(conversations.id, runs.conversationId))
    .where(
      and(
        gte(runs.createdAt, startedAt),
        inArray(runs.agentId, [manager, specialist.id]),
        inArray(conversations.channel, ["telegram", "web"]),
      ),
    );
  check(elsewhere.length === 0, "the manager and the specialist never ran in a conversation the user reads");
  console.log(`specialist: ${done.status}; ${done.output?.slice(0, 160)}`);
  console.log(`manager: ${review?.status}; ${review?.output?.slice(0, 200)}`);
  const answer = inboxMessages.findLast((m) => m.role === "assistant");
  console.log(`super agent: ${JSON.stringify(answer?.parts ?? []).slice(0, 400)}`);

  // 2. Work with nothing to report ends at the specialist.
  const quiet = await createSchedule({
    agentId: specialist.id,
    projectId: project.id,
    name: "E2E uptime check",
    kind: "once",
    runAt: NEVER,
    prompt:
      "Routine check: confirm that 2 + 2 equals 4. If it does, nothing is new and nothing needs anyone's attention, so end this task with nothingNew and a one-line output.",
  });
  createdSchedules.push(quiet.id);
  await runScheduleNow(quiet.id);
  await until("the quiet task to settle", async () => {
    const [t] = await taskOf(quiet.id);
    return (await idle()) && Boolean(t) && t!.status !== "in_progress" && t!.status !== "backlog";
  });
  const quietRows = await taskOf(quiet.id);
  check(
    quietRows.length === 1 && quietRows[0]!.status === "done" && quietRows[0]!.reportedAt !== null,
    "nothingNew ended the task as done, with no review task for the manager",
  );
  const quietNote = await db.select().from(taskComments).where(eq(taskComments.taskId, quietRows[0]!.id));
  check(quietNote.length >= 2, "the task says where it came from and that nothing was new");
  const inboxAfter = await db.select().from(messages).where(eq(messages.conversationId, inbox!.id));
  check(
    inboxAfter.filter((m) => isDelegationReport(m.metadata)).length === 1,
    "the super agent got no report for the quiet task",
  );
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  for (const id of createdSchedules) await deleteSchedule(id).catch(() => undefined);
  // The super agent's runs outlive its conversation (set null), so they go first.
  for (const id of inboxes) {
    await db.delete(runs).where(and(eq(runs.conversationId, id), eq(runs.agentId, orchestrator.id)));
    await deleteConversation(id).catch(() => undefined);
  }
  for (const id of createdProjects) await deleteProject(id, { actor: "e2e" }).catch(() => undefined);
  if (createdAgents.length) {
    await db.delete(conversations).where(inArray(conversations.agentId, createdAgents));
    await db.delete(agents).where(inArray(agents.id, createdAgents));
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
  process.exit(failures.length ? 1 : 0);
}
