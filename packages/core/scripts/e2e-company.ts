import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  agents,
  conversations,
  db,
  messages,
  type ModelRef,
  runs,
  settings as settingsTable,
  taskComments,
  tasks,
} from "@abotica/db";
import { and, asc, eq, gte, inArray, or } from "@abotica/db/orm";
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
import { wait } from "./e2e-shared";

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

type Scenario = (h: Harness) => Promise<void>;

const MODEL: ModelRef = {
  provider: process.env.E2E_PROVIDER ?? "anthropic",
  model: process.env.E2E_MODEL ?? "claude-haiku-4-5-20251001",
};
const SCENARIOS_DIR = join(import.meta.dirname, "company");

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
const scenarioName = (argIndex >= 0 ? process.argv[argIndex + 1] : undefined) ?? "s00";

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

/**
 * The company's runs since the start: its agents', the ones in the conversations it made, and any agent's
 * in its project (a manager may add an agent of the install to the team and give it work).
 */
async function companyRuns(): Promise<Run[]> {
  const agentIds = [...created.agents];
  const conversationIds = [...created.conversations];
  const mine = [
    ...(agentIds.length ? [inArray(runs.agentId, agentIds)] : []),
    ...(conversationIds.length ? [inArray(runs.conversationId, conversationIds)] : []),
    ...(projectId ? [eq(runs.projectId, projectId)] : []),
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

const clip = (text: string, max = 600) => (text.length > max ? `${text.slice(0, max)} [...]` : text);

/** One message part as a line of the transcript: text, or a tool call with its input and result in short. */
function partLine(part: Record<string, unknown>): string | null {
  if (part.type === "text") return String(part.text ?? "").trim() || null;
  if (typeof part.type === "string" && (part.type.startsWith("tool-") || part.type === "dynamic-tool")) {
    const name = part.type === "dynamic-tool" ? String(part.toolName) : part.type.slice(5);
    const output = part.output === undefined ? "" : ` -> ${clip(JSON.stringify(part.output), 300)}`;
    return `[tool ${name}] ${clip(JSON.stringify(part.input ?? {}), 300)}${output}`;
  }
  return null;
}

/**
 * The agents' conversations and the task comments, in order, written to a file for a person to read: what
 * they asked each other, what they answered, what reached whom. E2E_OUT sets the folder.
 */
async function writeTranscript(scenario: string): Promise<void> {
  const agentIds = [...created.agents];
  const rows = agentIds.length
    ? await db
        .select({ id: conversations.id, agentId: conversations.agentId, title: conversations.title })
        .from(conversations)
        .where(or(inArray(conversations.agentId, agentIds), inArray(conversations.id, [...created.conversations])))
    : [];
  const names = new Map(
    (await db.select({ id: agents.id, slug: agents.slug }).from(agents)).map((a) => [a.id, a.slug] as const),
  );
  const lines: string[] = [`# Transcript of ${scenario}`, ""];
  for (const conversation of rows) {
    const list = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(asc(messages.createdAt));
    if (!list.length) continue;
    lines.push(`## ${names.get(conversation.agentId) ?? conversation.agentId}: ${conversation.title}`, "");
    for (const message of list) {
      const body = (message.parts as Record<string, unknown>[]).map(partLine).filter(Boolean).join("\n");
      if (body) lines.push(`**${message.role}** ${message.createdAt.toISOString().slice(11, 19)}`, clip(body, 2000), "");
    }
  }
  const taskIds = projectId
    ? (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, projectId))).map((t) => t.id)
    : [];
  const allTasks = [...new Set([...taskIds, ...created.tasks])];
  if (allTasks.length) {
    lines.push("## Task comments", "");
    const comments = await db
      .select()
      .from(taskComments)
      .where(inArray(taskComments.taskId, allTasks))
      .orderBy(asc(taskComments.createdAt));
    for (const c of comments) {
      const author = c.authorAgentId ? names.get(c.authorAgentId) : c.authorKind;
      lines.push(
        `- ${c.createdAt.toISOString().slice(11, 19)} ${c.kind} by ${author} on ${c.taskId.slice(0, 8)}: ${clip(c.body, 400)}`,
      );
    }
  }
  const folder = process.env.E2E_OUT ?? join(tmpdir(), "abotica-e2e");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${scenario}-${Date.now()}.md`);
  writeFileSync(file, lines.join("\n"));
  console.log(`transcript: ${file}`);
}

/** Stops what still runs, then deletes the tasks, project, runs, conversations and agents it created. */
async function cleanup(): Promise<void> {
  const agentIds = [...created.agents];
  const agentConversations = agentIds.length
    ? await db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.agentId, agentIds))
    : [];
  // The conversations other agents of the install opened for the project are the scenario's too: only
  // ones made since it started, never a conversation that was there before.
  const touched = [...new Set((await companyRuns()).flatMap((r) => (r.conversationId ? [r.conversationId] : [])))];
  const borrowed = touched.length
    ? (
        await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(inArray(conversations.id, touched), gte(conversations.createdAt, startedAt)))
      ).map((c) => c.id)
    : [];
  const conversationIds = [...new Set([...created.conversations, ...agentConversations.map((c) => c.id), ...borrowed])];
  for (const id of conversationIds) await cancelConversationRuns(id, "E2E cleanup", "cancelled_by_user");
  // A running run ends in the worker; deleting it under the worker's feet only makes noise in its log.
  await waitFor(
    "the company's runs to stop",
    async () => !(await companyRuns()).some((r) => ["queued", "running"].includes(r.status)),
    {
      timeoutMs: 60_000,
      allowFailures: true,
    },
  ).catch(async (error: unknown) => {
    const going = (await companyRuns()).filter((r) => ["queued", "running"].includes(r.status));
    console.warn(String(error), going.map((r) => `${r.id} ${r.status} ${r.trigger} agent ${r.agentId}`).join("; "));
  });

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
  await writeTranscript(scenarioName).catch((error: unknown) => console.warn(`transcript: ${String(error)}`));
  // E2E_KEEP=1 leaves everything in place to look at; the next run cleans nothing of it.
  if (process.env.E2E_KEEP === "1") console.log(`kept: project ${projectId}`);
  else
    await cleanup().catch((error: unknown) => {
      failures.push(`cleanup: ${String(error)}`);
      console.error(error);
    });
  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
  process.exit(failures.length ? 1 : 0);
}
