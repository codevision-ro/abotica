import {
  applyConsolidation,
  checkForUpdates,
  type ConsolidationTarget,
  consolidationCandidates,
  consolidationPrompt,
  costSince,
  dayBounds,
  deleteExpiredMemories,
  embedText,
  getOrchestrator,
  getSettings,
  journalPrompt,
  type MaintenanceJob,
  maintenanceQueue,
  NoAllowedProviderError,
  notifyUpdateAvailable,
  parseConsolidation,
  projectProviderPolicy,
  projectsClosedTo,
  promoteRecalledMemories,
  QUEUE,
  refreshCatalog,
  requeueMissedReports,
  resolveModelChain,
  createRedis,
  sendBudgetAlerts,
  settingsLocale,
  sweepFiles,
  sweepPreviews,
  syncSettingsSchedules,
  unreadableConsolidation,
} from "@abotica/core";
import { clipUntrusted, hasUntrusted } from "@abotica/core/agents/untrusted";
import { recoverRuns } from "@abotica/core/run-lifecycle";
import { initSandbox, reapSandbox, removeWorkspace } from "@abotica/core/sandbox-runtime";
import { localeEnglishNames } from "@abotica/i18n";
import { agents, db, journals, projects, runEvents, runs, tasks } from "@abotica/db";
import { and, asc, eq, gte, inArray, lt, ne } from "@abotica/db/orm";
import { Worker } from "bullmq";
import { botTranslator, getBot, notifyChatId } from "../telegram/bot";
import { sendMarkdown } from "../telegram/send";
import { groupByJournal, type JournalKey, journalHeading, splitByProject, verbatimJournals } from "./journal-groups";
import { systemCompletion } from "./llm";
import { describeSandbox } from "./sandbox";

/** Removes unclaimed uploads and bytes without a row; logs only when something went. */
async function sweepStoredFiles() {
  const { pending, orphaned } = await sweepFiles();
  if (pending || orphaned) console.log(`[files] swept ${pending} unclaimed uploads, ${orphaned} orphaned files`);
}

/**
 * Fails runs nothing is going to end any more and sends the budget alerts that are due; logs only
 * when there were some.
 */
export async function reapRuns() {
  const failed = await recoverRuns();
  if (failed) console.log(`[runs] failed ${failed} runs nothing was executing any more`);
  const requeued = await requeueMissedReports();
  if (requeued) console.log(`[delegation] queued ${requeued} missed delegation reports again`);
  // Rides on the reaper's minute; a failure here must not fail the reaper's job.
  const alerts = await sendBudgetAlerts().catch((error: unknown) => {
    console.error("[budgets] checking the budget alerts failed:", error);
    return 0;
  });
  if (alerts) console.log(`[budgets] sent ${alerts} budget alerts`);
}

async function sweepExpiredPreviews() {
  const expired = await sweepPreviews();
  if (expired) console.log(`[previews] removed ${expired} expired previews`);
}

/** Names of the given projects, by id. */
async function projectNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id) => id !== null))];
  if (!wanted.length) return new Map();
  const rows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, wanted));
  return new Map(rows.map((p) => [p.id, p.name]));
}

/**
 * A journal of a project that allows none of the agent's providers is not written (or consolidated)
 * by another provider: it is skipped. Any other error is thrown on.
 */
const unlessNoAllowedProvider =
  (what: string) =>
  (error: unknown): null => {
    if (!(error instanceof NoAllowedProviderError)) throw error;
    console.warn(`[maintenance] ${what} skipped: the project allows none of the agent's providers`);
    return null;
  };

/** One journal per agent, per project and day: an agent working on two projects writes two. */
export async function writeJournals() {
  const settings = await getSettings();
  const { day, start, end } = dayBounds(settings.timezone);
  // Run times in the user's time zone, like the day the journal is written for.
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: settings.timezone, hour: "2-digit", minute: "2-digit" });
  const language = localeEnglishNames[settingsLocale(settings)];
  const allRuns = await db
    .select()
    .from(runs)
    .where(and(gte(runs.createdAt, start), lt(runs.createdAt, end), ne(runs.trigger, "system")))
    .orderBy(asc(runs.createdAt));
  // A deleted agent has no journal to write to; its runs only count for costs.
  const groups = groupByJournal(allRuns.flatMap((run) => (run.agentId ? [{ ...run, agentId: run.agentId }] : [])));
  const names = await projectNames(groups.map((g) => g.projectId));

  for (const { agentId, projectId, items: dayRuns } of groups) {
    const agent = await db.query.agents.findFirst({ where: (a, { eq }) => eq(a.id, agentId) });
    if (!agent) continue;
    const toolCalls = await db
      .select({ runId: runEvents.runId, data: runEvents.data })
      .from(runEvents)
      .where(
        and(
          inArray(
            runEvents.runId,
            dayRuns.map((r) => r.id),
          ),
          eq(runEvents.type, "step"),
        ),
      );

    const log = dayRuns
      .map((r) => {
        const tools = toolCalls
          .filter((t) => t.runId === r.id)
          .flatMap((t) => ((t.data.toolCalls as { name: string }[]) ?? []).map((c) => c.name));
        return [
          `## Run ${time.format(r.createdAt)} (${r.trigger}, ${r.status})`,
          // A webhook payload in the input stays inside its block, however the cut falls.
          `Request: ${clipUntrusted(r.input, 1_500)}`,
          tools.length ? `Tools: ${[...new Set(tools)].join(", ")}` : null,
          `Result: ${(r.output ?? r.error ?? "").slice(0, 2_000)}`,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");

    const summary = await systemCompletion({
      agent,
      projectId,
      purpose: `Journal ${day}`,
      ...journalPrompt({ day, timezone: settings.timezone, language, project: projectId && names.get(projectId), log }),
    }).catch(unlessNoAllowedProvider(`journal of ${agent.slug}`));
    if (summary === null) continue;
    const embedding = await embedText(summary, await projectProviderPolicy(projectId));
    // Facts consolidated from a day that read untrusted content are untrusted too. The input counts on
    // its own: a run that is still going, or failed before its prompt was read, has no flag yet.
    const fromUntrusted = dayRuns.some((r) => r.readUntrusted || hasUntrusted(r.input));
    await db
      .insert(journals)
      .values({ agentId, projectId, day, summary, embedding, fromUntrusted })
      .onConflictDoUpdate({
        target: [journals.agentId, journals.projectId, journals.day],
        set: { summary, embedding, fromUntrusted },
      });
  }
}

async function sendDigest(period: "daily" | "weekly") {
  const bot = getBot();
  const chatId = notifyChatId();
  const settings = await getSettings();
  const language = localeEnglishNames[settingsLocale(settings)];
  const days = period === "daily" ? 1 : 7;
  const { start } = dayBounds(settings.timezone, new Date(Date.now() - (days - 1) * 86_400_000));
  const startDay = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone }).format(start);

  const recentJournals = await db
    .select({
      agent: agents.name,
      projectId: journals.projectId,
      project: projects.name,
      day: journals.day,
      summary: journals.summary,
    })
    .from(journals)
    .innerJoin(agents, eq(agents.id, journals.agentId))
    .leftJoin(projects, eq(projects.id, journals.projectId))
    .where(gte(journals.day, startDay))
    .orderBy(asc(journals.day));
  const spend = await costSince(start);
  const done = await db
    .select({ title: tasks.title, projectId: tasks.projectId })
    .from(tasks)
    .where(and(eq(tasks.status, "done"), gte(tasks.completedAt, start)));
  const waiting = await db
    .select({ title: tasks.title, status: tasks.status, projectId: tasks.projectId })
    .from(tasks)
    .where(inArray(tasks.status, ["blocked", "review"]));
  const failed = await db
    .select({ kind: runs.failureKind })
    .from(runs)
    .where(and(eq(runs.status, "failed"), gte(runs.createdAt, start)));
  // By kind, so the digest tells a rejected key from a passing rate limit.
  const failedByKind = new Map<string, number>();
  for (const { kind } of failed) failedByKind.set(kind ?? "other", (failedByKind.get(kind ?? "other") ?? 0) + 1);
  const failedKinds = [...failedByKind].map(([kind, count]) => `${kind} ${count}`).join(", ");

  // Content of a project whose restriction the digest's models do not satisfy never reaches them:
  // its tasks are left out and its journals follow the digest as they were written.
  const orchestrator = await getOrchestrator();
  const closed = await projectsClosedTo(resolveModelChain(orchestrator, settings));
  const journalsBy = splitByProject(recentJournals, closed);
  const doneTitles = splitByProject(done, closed).open.map((t) => t.title);
  const waitingTitles = splitByProject(waiting, closed).open.map((t) => `${t.title} (${t.status})`);
  const summary = await systemCompletion({
    agent: orchestrator,
    projectId: null,
    purpose: `Digest ${period}`,
    instructions: `You are the super agent. You write a short report for the user, in ${language}, easy to read on a phone. Use simple Markdown.`,
    prompt: [
      `Write the ${period} digest: achievements, what is waiting for the user's decision, blockers, costs. At most 15 lines.`,
      `Total cost: $${spend.toFixed(4)}`,
      `Tasks done: ${doneTitles.join("; ") || "none"}`,
      `Tasks blocked or in review: ${waitingTitles.join("; ") || "none"}`,
      `Failed runs: ${failed.length}${failed.length ? ` (by kind: ${failedKinds})` : ""}`,
      "",
      "# Agent journals",
      ...journalsBy.open.map((j) => `${journalHeading(j)}\n${j.summary}`),
    ].join("\n"),
  });
  // A reached budget skips the digest like the other background calls.
  if (summary === null) return;
  const t = await botTranslator();
  const digest = [summary, verbatimJournals(t("telegram.digest.restrictedJournals"), journalsBy.closed)]
    .filter(Boolean)
    .join("\n\n");
  if (bot && chatId) await sendMarkdown(bot, { chatId }, digest);
}

/**
 * Moves the facts worth keeping from the unconsolidated journals into long-term memory: a project journal's
 * facts into the project's memory, written by the agent; a journal outside any project into the agent's
 * own. Each fact comes with how long it holds and the existing entries it restates or replaces (see
 * planFact). Then the weekly upkeep: promotion and expiry.
 */
export async function consolidate() {
  await consolidateJournals();
  const promoted = await promoteRecalledMemories();
  const expired = await deleteExpiredMemories();
  if (promoted || expired) console.log(`[memory] made ${promoted} entries permanent, deleted ${expired} expired`);
}

async function consolidateJournals() {
  const language = localeEnglishNames[settingsLocale(await getSettings())];
  const pending = await db.select().from(journals).where(eq(journals.consolidated, false)).orderBy(asc(journals.day));
  const groups = groupByJournal(pending);
  const names = await projectNames(groups.map((g) => g.projectId));
  for (const group of groups) {
    // Journals whose consolidation fails are tried again next time; the others, and the upkeep, go on.
    await consolidateGroup(group, language, names).catch((error: unknown) =>
      console.error(`[memory] consolidation of the journals of agent ${group.agentId} failed:`, error),
    );
  }
}

/** Consolidates one agent's journals of one project (null: outside projects); see consolidate. */
async function consolidateGroup(
  { agentId, projectId, items: entries }: JournalKey & { items: (typeof journals.$inferSelect)[] },
  language: string,
  names: Map<string, string>,
) {
  const agent = await db.query.agents.findFirst({ where: (a, { eq }) => eq(a.id, agentId) });
  if (!agent) return;
  const target: ConsolidationTarget = projectId ? { scope: "project", projectId, agentId } : { scope: "agent", agentId };
  const related = await consolidationCandidates(target, entries);
  const output = await systemCompletion({
    agent,
    projectId,
    purpose: "Memory consolidation",
    ...consolidationPrompt({
      language,
      project: projectId && names.get(projectId),
      journals: entries,
      existing: related,
    }),
  }).catch(unlessNoAllowedProvider(`memory consolidation of ${agent.slug}`));
  // Left unconsolidated: they are tried again next time.
  if (output === null) return;
  const parsed = parseConsolidation(output, related.length);
  if (unreadableConsolidation(output, parsed)) {
    console.warn(
      `[memory] consolidation of ${agent.slug} gave no fact to read (${parsed.malformed} malformed lines): its journals are tried again next time`,
    );
    return;
  }
  if (parsed.malformed)
    console.warn(`[memory] consolidation of ${agent.slug}: skipped ${parsed.malformed} malformed lines`);
  // Facts from a day that read untrusted content wait for the user's approval.
  const origin = entries.some((j) => j.fromUntrusted) ? "untrusted" : "system";
  const done = await applyConsolidation(target, parsed.facts, related, origin);
  console.log(
    `[memory] consolidated ${entries.length} journals of ${agent.slug}: ${done.added} added, ${done.held} held for approval, ${done.restated} restated, ${done.dropped} dropped`,
  );
  await db
    .update(journals)
    .set({ consolidated: true })
    .where(
      inArray(
        journals.id,
        entries.map((j) => j.id),
      ),
    );
}

export async function registerMaintenanceSchedules() {
  await syncSettingsSchedules();
  const q = maintenanceQueue();
  await q.upsertJobScheduler("catalog", { every: 12 * 3600_000 }, { name: "catalog", data: { kind: "catalog" } });
  await q.upsertJobScheduler(
    "sandbox-reap",
    { every: 5 * 60_000 },
    { name: "sandbox-reap", data: { kind: "sandbox-reap" } },
  );
  await q.upsertJobScheduler("runs-reap", { every: 60_000 }, { name: "runs-reap", data: { kind: "runs-reap" } });
  await q.upsertJobScheduler("files-sweep", { every: 3600_000 }, { name: "files-sweep", data: { kind: "files-sweep" } });
  await q.upsertJobScheduler(
    "previews-sweep",
    { every: 3600_000 },
    { name: "previews-sweep", data: { kind: "previews-sweep" } },
  );
  // Every 6 hours, and once now so a fresh install or an update knows where it stands.
  await q.upsertJobScheduler(
    "updates-check",
    { every: 6 * 3600_000 },
    { name: "updates-check", data: { kind: "updates-check" } },
  );
  await q.add("updates-check", { kind: "updates-check" }, { removeOnComplete: true, removeOnFail: true });
}

export function startMaintenanceWorker() {
  return new Worker<MaintenanceJob>(
    QUEUE.maintenance,
    async (job) => {
      switch (job.data.kind) {
        case "journals":
          return writeJournals();
        case "digest":
          return sendDigest(job.data.period);
        case "consolidate":
          return consolidate();
        case "catalog":
          return void (await refreshCatalog());
        case "sandbox-check": {
          const status = await initSandbox();
          return console.log(`[sandbox] ${describeSandbox(status)}`);
        }
        case "sandbox-remove":
          return removeWorkspace(job.data.key);
        case "sandbox-reap":
          return reapSandbox();
        case "files-sweep":
          return sweepStoredFiles();
        case "previews-sweep":
          return sweepExpiredPreviews();
        case "runs-reap":
          return reapRuns();
        case "updates-check":
          return void (await notifyUpdateAvailable(await checkForUpdates()));
      }
    },
    { connection: createRedis(), concurrency: 1 },
  );
}
