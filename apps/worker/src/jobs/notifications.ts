import { createRedis, env, type NotificationJob, QUEUE } from "@abotica/core";
import { agents, approvals, conversations, db, projects, runs, taskComments, tasks } from "@abotica/db";
import { and, desc, eq } from "@abotica/db/orm";
import { Worker } from "bullmq";
import { InlineKeyboard } from "grammy";
import { botTranslator, getBot, notifyChatId } from "../telegram/bot";
import { sendTelegramNotice } from "../telegram/delivery";
import { runFinishedNotice } from "../telegram/routing";
import { sendMarkdown, type Target } from "../telegram/send";

/** Project notifications go to the project's forum topic when one is configured. */
async function targetFor(projectId: string | null | undefined): Promise<Target | null> {
  const chatId = await notifyChatId();
  if (!chatId) return null;
  if (!projectId) return { chatId };
  const [project] = await db.select({ topic: projects.telegramTopicId }).from(projects).where(eq(projects.id, projectId));
  return { chatId, threadId: project?.topic ?? null };
}

/** The delegating agent reports a delegated task's result in that Telegram chat itself. */
async function delegatedFromTelegram(delegatorRunId: string): Promise<boolean> {
  const [origin] = await db
    .select({ channel: conversations.channel })
    .from(runs)
    .innerJoin(conversations, eq(conversations.id, runs.conversationId))
    .where(eq(runs.id, delegatorRunId));
  return origin?.channel === "telegram";
}

const APPROVAL_PREVIEW = 600;

const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

const preview = (value: unknown, max = APPROVAL_PREVIEW) => {
  const text = asText(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

async function handle(job: NotificationJob) {
  const bot = getBot();
  if (!bot) return;
  const t = await botTranslator();

  if (job.kind === "text") {
    const target = await targetFor(job.projectId);
    if (target) await sendMarkdown(bot, target, job.text);
    return;
  }

  // Web conversations show the notice in the chat; a Telegram one gets it in its own chat.
  if (job.kind === "conversation-notice") {
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, job.conversationId));
    if (conversation?.channel === "telegram") await sendTelegramNotice(conversation, job.text);
    return;
  }

  if (job.kind === "approval") {
    const [row] = await db
      .select({ approval: approvals, agent: agents.name, projectId: runs.projectId })
      .from(approvals)
      .innerJoin(agents, eq(agents.id, approvals.agentId))
      .innerJoin(runs, eq(runs.id, approvals.runId))
      .where(eq(approvals.id, job.approvalId));
    if (!row || row.approval.status !== "pending") return;
    const target = await targetFor(row.projectId);
    if (!target) return;
    const keyboard = new InlineKeyboard()
      .text(t("notifications.approval.approve"), `ap:${row.approval.id}:1`)
      .text(t("notifications.approval.reject"), `ap:${row.approval.id}:0`);
    const input = asText(row.approval.input);
    const text = [
      t("notifications.approval.title"),
      t("notifications.approval.request", { agent: row.agent, tool: row.approval.toolName }),
      row.approval.reason ? t("notifications.approval.reason", { reason: row.approval.reason }) : null,
      "",
      preview(input),
      // The buttons approve the whole input, not only the part shown here.
      ...(input.length > APPROVAL_PREVIEW
        ? [
            "",
            t("approvals.telegram.inputTruncated", {
              shown: APPROVAL_PREVIEW,
              total: input.length,
              url: new URL("/approvals", env().APP_URL).toString(),
            }),
          ]
        : []),
    ]
      .filter((l) => l !== null)
      .join("\n");
    // Plain text: tool input is arbitrary JSON and must not be parsed as Markdown.
    const msg = await bot.api.sendMessage(target.chatId, text, {
      reply_markup: keyboard,
      ...(target.threadId ? { message_thread_id: target.threadId } : {}),
    });
    await db.update(approvals).set({ telegramMessageId: msg.message_id }).where(eq(approvals.id, row.approval.id));
    return;
  }

  // The super agent's own runs notify, and the user's own tasks; the rest reports up (see runFinishedNotice).
  if (job.kind === "run-finished") {
    const [row] = await db
      .select({ run: runs, agent: agents.name, kind: agents.kind, task: tasks })
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .leftJoin(tasks, eq(tasks.id, runs.taskId))
      .where(eq(runs.id, job.runId));
    const notice = row && runFinishedNotice(row.run, row.kind, row.task);
    if (!row || !notice) return;
    const { task } = row;
    if (task?.delegatedByRunId && (await delegatedFromTelegram(task.delegatedByRunId))) return;
    const target = await targetFor(row.run.projectId);
    if (!target) return;
    const subject = task ? "task" : row.run.trigger === "schedule" ? "schedule" : "run";
    const values = { agent: row.agent ?? t("runs.agentChip.deleted"), task: task?.title ?? "" };
    const link = task ? `\n\n[${t("notifications.openTask")}](${new URL(`/tasks/${task.id}`, env().APP_URL)})` : "";
    if (notice === "failed") {
      await sendMarkdown(bot, target, `${t(`notifications.runFailed.${subject}`, values)}\n${row.run.error ?? ""}${link}`);
    } else if (notice === "blocked") {
      // Why it is blocked: what the agent wrote last on the task.
      const [reason] = await db
        .select({ body: taskComments.body })
        .from(taskComments)
        .where(and(eq(taskComments.taskId, task!.id), eq(taskComments.authorKind, "agent")))
        .orderBy(desc(taskComments.createdAt))
        .limit(1);
      await sendMarkdown(
        bot,
        target,
        `${t("notifications.taskBlocked", values)}${reason ? `\n\n${preview(reason.body, 1_500)}` : ""}${link}`,
      );
    } else {
      const result = task?.output ?? row.run.output ?? "";
      await sendMarkdown(
        bot,
        target,
        `${t(`notifications.runSucceeded.${subject}`, values)}\n\n${preview(result, 3_000)}${link}`,
      );
    }
  }
}

export function startNotificationsWorker() {
  return new Worker<NotificationJob>(QUEUE.notifications, (job) => handle(job.data), {
    connection: createRedis(),
    concurrency: 2,
    // Telegram allows ~30 messages/second; stay far below.
    limiter: { max: 10, duration: 1_000 },
  });
}
