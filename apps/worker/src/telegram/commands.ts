import {
  answerQuestion,
  costSince,
  countTasksByStatus,
  dayBounds,
  decideApproval,
  getSettings,
  listActiveRuns,
  listOpenTasks,
  listWaitingForUser,
  redis,
  setKillSwitch,
  waitingMessage,
} from "@abotica/core";
import { isUserError, translateKey, type Translator } from "@abotica/i18n";
import { agents, approvals, db, taskComments, tasks } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { botTranslator } from "./bot";
import { currentConversation } from "./chat";
import { sendMarkdown, type Target } from "./send";

/** Questions shown again by /waiting, each with its buttons; the rest are in the list and the inbox. */
const WAITING_QUESTIONS_SHOWN = 5;
/** Characters of a question's text in its message, and of an option on its button. */
const QUESTION_CHARS = 3_000;
const OPTION_CHARS = 60;
/** How long a reply to a question's message still answers it. */
const REPLY_TTL_SECONDS = 30 * 24 * 3600;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Which question a Telegram message asked, so a reply to it is its answer. */
const questionMessageKey = (chatId: number, messageId: number) => `abotica:telegram:question:${chatId}:${messageId}`;

/** The question asked by this message of the chat, if it was one. */
export async function questionAskedBy(chatId: number, messageId: number): Promise<string | null> {
  return redis().get(questionMessageKey(chatId, messageId));
}

/** An option as the user reads it: the platform's own options (continue, redirect, cancel) translated. */
function optionLabel(t: Translator, option: string, system: boolean): string {
  if (!system) return option;
  const key = `inbox.question.systemOptions.${option}`;
  const label = translateKey(t, key);
  return label === key ? option : label;
}

/**
 * Sends an open question to the user: who asks, about which task, its text, and its options as buttons
 * (q:<id>:<n>). A reply to the message answers it in the user's own words. False when it is not open.
 */
export async function sendQuestion(bot: Bot, questionId: string, target: Target): Promise<boolean> {
  const [row] = await db
    .select({ question: taskComments, task: tasks.title, agent: agents.name })
    .from(taskComments)
    .innerJoin(tasks, eq(tasks.id, taskComments.taskId))
    .leftJoin(agents, eq(agents.id, taskComments.authorAgentId))
    .where(eq(taskComments.id, questionId));
  if (!row || row.question.questionStatus !== "open") return false;
  const t = await botTranslator();
  const { options } = row.question;
  const system = Boolean(options?.system);
  const keyboard = new InlineKeyboard();
  options?.options.forEach((option, n) => {
    keyboard.text(cut(optionLabel(t, option, system), OPTION_CHARS), `q:${questionId}:${n}`).row();
  });
  const text = [
    t("inbox.telegram.question.title", { from: row.agent ?? t("inbox.telegram.question.system") }),
    t("inbox.telegram.question.task", { task: row.task }),
    "",
    cut(row.question.body.trim(), QUESTION_CHARS),
    ...(options?.recommendation
      ? ["", t("inbox.telegram.question.recommended", { option: optionLabel(t, options.recommendation, system) })]
      : []),
    "",
    t("inbox.telegram.question.hint"),
  ].join("\n");
  // Plain text: an agent wrote the question, and it must not be parsed as Markdown.
  const msg = await bot.api.sendMessage(target.chatId, text, {
    ...(options?.options.length ? { reply_markup: keyboard } : {}),
    ...(target.threadId ? { message_thread_id: target.threadId } : {}),
  });
  await redis().set(questionMessageKey(target.chatId, msg.message_id), questionId, "EX", REPLY_TTL_SECONDS);
  return true;
}

/**
 * Answers a question from Telegram, as the user. The text to show for the outcome: the question was
 * answered, or why not (it is closed, or the answer failed).
 */
export async function answerFromTelegram(questionId: string, answer: string): Promise<{ ok: boolean; text: string }> {
  const t = await botTranslator();
  const [question] = await db
    .select({ status: taskComments.questionStatus })
    .from(taskComments)
    .where(eq(taskComments.id, questionId));
  if (question?.status !== "open") return { ok: false, text: t("inbox.telegram.question.closed") };
  try {
    await answerQuestion(questionId, answer, "user");
    return { ok: true, text: t("inbox.telegram.question.sent") };
  } catch (error) {
    if (!isUserError(error)) throw error;
    return { ok: false, text: translateKey(t, error.key, error.values) };
  }
}

/** Where a command was sent from: its chat, and its forum topic if any. */
const replyTarget = (ctx: Context): Target => ({ chatId: ctx.chat!.id, threadId: ctx.msg?.message_thread_id ?? null });

/** Slash commands and the inline buttons they (and approval notifications) show. */
export function registerCommands(bot: Bot) {
  bot.command("start", async (ctx) => ctx.reply((await botTranslator())("telegram.start")));

  bot.command("new", async (ctx) => {
    await currentConversation(ctx, true);
    await ctx.reply((await botTranslator())("telegram.newConversation"));
  });

  bot.command("stop", async (ctx) => {
    const t = await botTranslator();
    // Running runs are aborted by the worker's kill switch subscription.
    const stopped = await setKillSwitch(true, t("errors.run.stoppedFromTelegram"));
    await ctx.reply(t("telegram.killSwitchOn", { count: stopped }));
  });

  bot.command("resume", async (ctx) => {
    await setKillSwitch(false);
    await ctx.reply((await botTranslator())("telegram.killSwitchOff"));
  });

  bot.command("status", async (ctx) => {
    const settings = await getSettings();
    const t = await botTranslator();
    const [active, tasks, cost] = await Promise.all([
      listActiveRuns(),
      countTasksByStatus(),
      costSince(dayBounds(settings.general.timezone).start),
    ]);
    const lines = [
      t("telegram.status.title"),
      active.length
        ? active
            .map(
              (r) =>
                `• ${r.agent ?? t("runs.agentChip.deleted")}: ${translateKey(t, `common.runStatus.${r.status}`)} (${r.trigger})`,
            )
            .join("\n")
        : t("telegram.status.noActiveAgents"),
      "",
      t("telegram.status.tasks", {
        inProgress: tasks.in_progress ?? 0,
        blocked: tasks.blocked ?? 0,
        review: tasks.review ?? 0,
      }),
      t("telegram.status.costToday", { cost: `$${cost.toFixed(4)}` }),
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.command("tasks", async (ctx) => {
    // Cancelled tasks are not open, only not done.
    const rows = (await listOpenTasks(20)).filter((r) => r.status !== "cancelled");
    if (!rows.length) return ctx.reply((await botTranslator())("telegram.tasks.empty"));
    const icon: Record<string, string> = { backlog: "⚪", in_progress: "🔵", paused: "⏸️", blocked: "🔴", review: "🟡" };
    await ctx.reply(rows.map((t) => `${icon[t.status]} ${t.title}${t.agent ? ` · ${t.agent}` : ""}`).join("\n"));
  });

  // What waits for the user: the list, then the open questions again with their buttons.
  bot.command("waiting", async (ctx) => {
    const t = await botTranslator();
    const items = await listWaitingForUser();
    if (!items.length) return ctx.reply(t("inbox.telegram.empty"));
    const target = replyTarget(ctx);
    await sendMarkdown(bot, target, await waitingMessage(items, { title: "list" }));
    const questions = items.filter((i) => i.kind === "question").slice(0, WAITING_QUESTIONS_SHOWN);
    for (const q of questions) await sendQuestion(bot, q.id, target);
  });

  bot.callbackQuery(/^q:([0-9a-f-]+):(\d+)$/, async (ctx) => {
    const [, id, index] = ctx.match;
    const t = await botTranslator();
    const [row] = await db.select({ options: taskComments.options }).from(taskComments).where(eq(taskComments.id, id!));
    const option = row?.options?.options[Number(index)];
    if (!option) return ctx.answerCallbackQuery({ text: t("inbox.telegram.question.closed") });
    const result = await answerFromTelegram(id!, option);
    await ctx.answerCallbackQuery({ text: result.text });
    const original = ctx.callbackQuery.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : "";
    const answer = optionLabel(t, option, Boolean(row?.options?.system));
    const verdict = result.ok ? t("inbox.telegram.question.verdict", { answer }) : result.text;
    // Without reply_markup the buttons go away: the question is answered, or no longer open.
    await ctx.editMessageText(`${original ?? ""}\n\n${verdict}`.trim()).catch(() => {});
  });

  bot.callbackQuery(/^ap:([0-9a-f-]+):([01])$/, async (ctx) => {
    const [, id, decision] = ctx.match;
    const approved = decision === "1";
    const t = await botTranslator();
    // The reason is read by the model when the run continues.
    const result = await decideApproval(id!, approved, {
      actor: `telegram:${ctx.from.id}`,
      reason: approved ? undefined : "Rejected from Telegram",
    });
    await ctx.answerCallbackQuery({
      text: result
        ? approved
          ? t("telegram.approval.approved")
          : t("telegram.approval.rejected")
        : t("telegram.approval.alreadyDecided"),
    });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id!));
    const original = ctx.callbackQuery.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : "";
    const verdict =
      row?.status === "approved"
        ? t("telegram.approval.verdictApproved")
        : row?.status === "rejected"
          ? t("telegram.approval.verdictRejected")
          : "";
    await ctx.editMessageText(`${original ?? ""}\n\n${verdict}`.trim()).catch(() => {});
  });
}
