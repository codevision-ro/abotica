import {
  costSince,
  countTasksByStatus,
  dayBounds,
  decideApproval,
  getSettings,
  listActiveRuns,
  listOpenTasks,
  setKillSwitch,
} from "@abotica/core";
import { translateKey } from "@abotica/i18n";
import { approvals, db } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import type { Bot } from "grammy";
import { botTranslator } from "./bot";
import { currentConversation } from "./chat";

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
    const rows = await listOpenTasks(20);
    if (!rows.length) return ctx.reply((await botTranslator())("telegram.tasks.empty"));
    const icon: Record<string, string> = { backlog: "⚪", in_progress: "🔵", blocked: "🔴", review: "🟡" };
    await ctx.reply(rows.map((t) => `${icon[t.status]} ${t.title}${t.agent ? ` · ${t.agent}` : ""}`).join("\n"));
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
