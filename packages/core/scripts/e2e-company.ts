import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agents, conversations, db, type ModelRef, runs, settings as settingsTable, tasks } from "@abotica/db";
import { and, eq, gte, inArray, or } from "@abotica/db/orm";
import {
  announceSettings,
  type AppSettings,
  cancelConversationRuns,
  createAgentFromTemplate,
  createConversation,
  createProject,
  createTask,
  deleteConversation,
  deleteProject,
  deleteTask,
  getOrchestrator,
  type Run,
  type SettingsDomain,
  type SettingsPatch,
  startDelegatedTask,
  type Task,
  type TaskPriority,
  updateSettings,
} from "../src/index";

/**
 * End-to-end checks of the company flow, one scenario per run: a project with a manager and two
 * specialists on a cheap model, and a scenario from scripts/company/sNN-*.ts that drives it and checks
 * the outcome in the database. Everything it creates is deleted at the end, and the settings it changed
 * are put back. Needs the worker running.
 * Usage: pnpm --filter @abotica/core e2e:company --scenario s00 (E2E_PROVIDER and E2E_MODEL pick the
 * model, default Anthropic's Haiku; the super agent gets it through its conversations only)
 */

type Agent = typeof agents.$inferSelect;
type Project = Awaited<ReturnType<typeof createProject>>;

/** What a scenario gets: the company, the checks and the helpers that create what it needs (and track it for cleanup). */
export type Harness = {
  model: ModelRef;
  /** When the run started: the rows a scenario looks at are the ones created since. */
  startedAt: Date;
  orchestrator: Agent;
  manager: Agent;
  /** The writer and the researcher, both on the project's team. */
  specialists: [Agent, Agent];
  project: Project;
  /** Records a check; a failed one fails the run but lets the scenario go on. */
  check: (ok: boolean, label: string) => void;
  /**
   * Polls `probe` until it returns something truthy, and returns it. Throws at the timeout, and as soon
   * as one of the company's runs fails (unless allowFailures, or the run was marked with expectFailure).
   */
  waitFor: <T>(
    label: string,
    probe: () => Promise<T | null | undefined | false>,
    opts?: { timeoutMs?: number; everyMs?: number; allowFailures?: boolean },
  ) => Promise<T>;
  /** A run the scenario fails on purpose: the final "no run failed" check leaves it out. */
  expectFailure: (runId: string) => void;
  /**
   * A finished run of `agentId` (default the manager) in a conversation of its own, to delegate from as
   * if that agent had: reports of the tasks it delegated arrive in that conversation and continue it.
   */
  delegatorRun: (opts?: { agentId?: string; taskId?: string | null; projectId?: string | null }) => Promise<Run>;
  /** A task in the project delegated by `from` (default: a new delegatorRun) to `to`, started unless start is false. */
  delegate: (input: {
    to: Agent;
    title: string;
    description: string;
    from?: Run;
    priority?: TaskPriority;
    deadline?: Date | null;
    dependsOn?: string[];
    start?: boolean;
  }) => Promise<Task>;
  /** A conversation with the super agent on the test model, as the user's chat. */
  superConversation: (title: string) => Promise<string>;
  /** Changes a settings domain for the scenario; the stored value is put back at the end. */
  setSettings: <D extends SettingsDomain>(domain: D, patch: SettingsPatch<AppSettings[D]>) => Promise<void>;
  /** Rows the scenario created another way, deleted at the end with the rest. */
  track: { conversation: (id: string) => void; task: (id: string) => void; agent: (id: string) => void };
};

export type Scenario = (h: Harness) => Promise<void>;

const MODEL: ModelRef = {
  provider: process.env.E2E_PROVIDER ?? "anthropic",
  model: process.env.E2E_MODEL ?? "claude-haiku-4-5-20251001",
};
const SCENARIOS_DIR = join(import.meta.dirname, "company");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function scenarioFile(id: string | undefined): string {
  const files = readdirSync(SCENARIOS_DIR).filter((f) => /^s\d{2}-.+\.ts$/.test(f));
  const file = id ? files.find((f) => f.startsWith(`${id}-`)) : undefined;
  if (!file) {
    console.error(`Usage: e2e:company --scenario sNN\nScenarios: ${files.map((f) => f.replace(/\.ts$/, "")).join(", ")}`);
    process.exit(1);
  }
  return join(SCENARIOS_DIR, file);
}

const argIndex = process.argv.indexOf("--scenario");
const file = scenarioFile(argIndex >= 0 ? process.argv[argIndex + 1] : undefined);

const startedAt = new Date();
const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

const created = { agents: new Set<string>(), conversations: new Set<string>(), tasks: new Set<string>() };
const expectedFailures = new Set<string>();
/** Settings rows as they were before the scenario changed them (undefined: there was none). */
const savedSettings = new Map<SettingsDomain, unknown>();
let projectId: string | null = null;

/** The company's runs since the start: its agents' and the ones in the conversations it made. */
async function companyRuns(): Promise<Run[]> {
  const agentIds = [...created.agents];
  const conversationIds = [...created.conversations];
  const mine = [
    ...(agentIds.length ? [inArray(runs.agentId, agentIds)] : []),
    ...(conversationIds.length ? [inArray(runs.conversationId, conversationIds)] : []),
  ];
  if (!mine.length) return [];
  return db
    .select()
    .from(runs)
    .where(and(gte(runs.createdAt, startedAt), or(...mine)));
}

async function unexpectedFailures(): Promise<Run[]> {
  return (await companyRuns()).filter((r) => r.status === "failed" && !expectedFailures.has(r.id));
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; everyMs?: number; allowFailures?: boolean } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (!opts.allowFailures) {
      const [failed] = await unexpectedFailures();
      if (failed) throw new Error(`run ${failed.id} failed while waiting for ${label}: ${failed.error ?? "no error"}`);
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await wait(opts.everyMs ?? 2000);
  }
}

async function delegatorRun(
  opts: { agentId?: string; taskId?: string | null; projectId?: string | null } = {},
  manager: Agent,
): Promise<Run> {
  const agentId = opts.agentId ?? manager.id;
  const conversation = await createConversation({ agentId, channel: "internal", title: "E2E delegator" });
  created.conversations.add(conversation.id);
  const now = new Date();
  const [run] = await db
    .insert(runs)
    .values({
      agentId,
      trigger: "delegation",
      status: "succeeded",
      input: "E2E: delegating work",
      conversationId: conversation.id,
      taskId: opts.taskId ?? null,
      projectId: opts.projectId === undefined ? projectId : opts.projectId,
      startedAt: now,
      finishedAt: now,
    })
    .returning();
  return run!;
}

async function setSettings<D extends SettingsDomain>(domain: D, patch: SettingsPatch<AppSettings[D]>): Promise<void> {
  if (!savedSettings.has(domain)) {
    const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, domain));
    savedSettings.set(domain, row?.value);
  }
  await updateSettings(domain, patch, { actor: "e2e" });
}

async function restoreSettings(): Promise<void> {
  for (const [domain, value] of savedSettings) {
    if (value === undefined) await db.delete(settingsTable).where(eq(settingsTable.key, domain));
    else await db.update(settingsTable).set({ value }).where(eq(settingsTable.key, domain));
    await announceSettings(domain);
  }
}

/** Stops what still runs, then deletes the tasks, project, runs, conversations and agents it created. */
async function cleanup(): Promise<void> {
  const agentIds = [...created.agents];
  const agentConversations = agentIds.length
    ? await db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.agentId, agentIds))
    : [];
  const conversationIds = [...new Set([...created.conversations, ...agentConversations.map((c) => c.id)])];
  for (const id of conversationIds) await cancelConversationRuns(id, "E2E cleanup", "cancelled_by_user");
  // A running run ends in the worker; deleting it under the worker's feet only makes noise in its log.
  await waitFor(
    "the company's runs to stop",
    async () => !(await companyRuns()).some((r) => ["queued", "running"].includes(r.status)),
    {
      timeoutMs: 60_000,
      allowFailures: true,
    },
  ).catch((error: unknown) => console.warn(String(error)));

  const ownRuns = await companyRuns();
  const runIds = ownRuns.map((r) => r.id);
  // Tasks the company's runs delegated outside the project (the super agent's) go with them.
  if (runIds.length) {
    const delegated = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.delegatedByRunId, runIds));
    for (const t of delegated) created.tasks.add(t.id);
  }
  if (projectId) await deleteProject(projectId, { actor: "e2e" }).catch((error: unknown) => console.warn(String(error)));
  for (const id of created.tasks) await deleteTask(id);
  if (runIds.length) await db.delete(runs).where(inArray(runs.id, runIds));
  for (const id of conversationIds) await deleteConversation(id);
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds));
  await restoreSettings();
}

try {
  const orchestrator = await getOrchestrator();
  const writer = await createAgentFromTemplate("template-writer", { name: "E2E Writer", actor: "e2e" });
  created.agents.add(writer.id);
  const researcher = await createAgentFromTemplate("template-researcher", { name: "E2E Researcher", actor: "e2e" });
  created.agents.add(researcher.id);
  const project = await createProject(
    {
      name: `E2E Company ${Date.now().toString(36)}`,
      description: "A small bakery called Crumb: its website, newsletter and local marketing.",
      goals: "More visitors from the neighbourhood.",
      memberIds: [writer.id, researcher.id],
    },
    { actor: "e2e" },
  );
  projectId = project.id;
  if (!project.managerAgentId) throw new Error("the project got no manager");
  created.agents.add(project.managerAgentId);
  await db
    .update(agents)
    .set({ ...MODEL, fallbacks: [] })
    .where(inArray(agents.id, [...created.agents]));
  const companyAgents = await db
    .select()
    .from(agents)
    .where(inArray(agents.id, [...created.agents]));
  const byId = (id: string) => companyAgents.find((a) => a.id === id)!;
  const manager = byId(project.managerAgentId);

  const h: Harness = {
    model: MODEL,
    startedAt,
    orchestrator,
    manager,
    specialists: [byId(writer.id), byId(researcher.id)],
    project,
    check,
    waitFor,
    expectFailure: (runId) => void expectedFailures.add(runId),
    delegatorRun: (opts) => delegatorRun(opts, manager),
    delegate: async ({ to, title, description, from, priority, deadline, dependsOn, start = true }) => {
      const delegator = from ?? (await delegatorRun({}, manager));
      const task = await createTask(
        {
          title,
          description,
          projectId: project.id,
          parentId: delegator.taskId,
          priority: priority ?? "medium",
          deadline: deadline ?? null,
          assigneeAgentId: to.id,
          dependsOn,
          delegatedByRunId: delegator.id,
        },
        "e2e",
      );
      created.tasks.add(task.id);
      if (start) await startDelegatedTask(task.id, { parentRunId: delegator.id });
      return task;
    },
    superConversation: async (title) => {
      const conversation = await createConversation({ agentId: orchestrator.id, channel: "internal", title });
      created.conversations.add(conversation.id);
      await db.update(conversations).set({ modelOverride: MODEL }).where(eq(conversations.id, conversation.id));
      return conversation.id;
    },
    setSettings,
    track: {
      conversation: (id) => void created.conversations.add(id),
      task: (id) => void created.tasks.add(id),
      agent: (id) => void created.agents.add(id),
    },
  };
  console.log(`project ${project.id}: manager ${manager.slug}, specialists ${writer.slug}, ${researcher.slug}`);
  console.log(`model ${MODEL.provider}/${MODEL.model}; scenario ${file}`);

  const scenario = (await import(pathToFileURL(file).href)) as { default: Scenario };
  await scenario.default(h);

  const failed = await unexpectedFailures();
  check(
    !failed.length,
    `no run failed${failed.length ? ` (failed: ${failed.map((r) => `${r.id} ${r.error ?? ""}`).join("; ")})` : ""}`,
  );
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  await cleanup().catch((error: unknown) => {
    failures.push(`cleanup: ${String(error)}`);
    console.error(error);
  });
  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
  process.exit(failures.length ? 1 : 0);
}
