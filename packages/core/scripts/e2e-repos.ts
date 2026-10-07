import { agents, conversations, db, messages, projectRepos, runEvents, runs } from "@abotica/db";
import { asc, eq } from "@abotica/db/orm";
import { REDACTED } from "../src/agents/redact";
import { taskBranch, taskWorktreePath } from "../src/agents/workspace-paths";
import {
  createAgentFromTemplate,
  createProject,
  createTask,
  deleteProject,
  encrypt,
  getSandboxStatus,
  startTaskRun,
} from "../src/index";

/**
 * End-to-end check of a project repository in a real sandbox: a specialist works on a task in a
 * project whose network is off, and must find the repository cloned, its task worktree on the
 * task's branch, git able to reach the host, and the token hidden from everything it reads.
 * Uses a public GitHub repository with a made-up token, so nothing is pushed. Needs the worker
 * running with the sandbox (docker compose).
 * Usage: pnpm --filter @abotica/core e2e:repos (E2E_PROVIDER and E2E_MODEL pick the model, default DeepSeek)
 */
const MODEL = { provider: process.env.E2E_PROVIDER ?? "deepseek", model: process.env.E2E_MODEL ?? "deepseek-v4-flash" };
const REPO = { host: "github.com", path: "octocat/Hello-World", defaultBranch: "master", name: "hello-world" };
const TOKEN = `ghp_e2e${Date.now().toString(36)}notarealtoken`;
const TIMEOUT_MS = 8 * 60_000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

const status = await getSandboxStatus();
console.log("sandbox:", status?.isolation ?? "not running");
if (!status?.isolation) {
  console.error("The sandbox is not running: start the worker with docker compose and check Settings > Sandbox.");
  process.exit(1);
}

let projectId: string | null = null;
let agentId: string | null = null;
try {
  const specialist = await createAgentFromTemplate("template-web-developer", { name: "E2E Repo developer" });
  agentId = specialist.id;
  await db
    .update(agents)
    .set({ ...MODEL, fallbacks: [] })
    .where(eq(agents.id, specialist.id));
  const project = await createProject({
    name: `E2E Repos ${Date.now().toString(36)}`,
    memberIds: [specialist.id],
    managerAgentId: null,
    sandbox: { network: { mode: "off", domains: [] }, packages: { python: [], node: [] } },
  });
  projectId = project.id;
  // Inserted directly: the provider check would reject a made-up token.
  await db.insert(projectRepos).values({
    projectId: project.id,
    name: REPO.name,
    provider: "github",
    host: REPO.host,
    path: REPO.path,
    defaultBranch: REPO.defaultBranch,
    token: encrypt(TOKEN),
    tokenHint: TOKEN.slice(-4),
    defaultBranchProtected: null,
  });

  const task = await createTask({
    title: "Inspect the repository",
    projectId: project.id,
    assigneeAgentId: specialist.id,
    description: [
      "Run each of these commands with shell_run, exactly as written, one call per command, and report their output:",
      "1. ls repos",
      "2. git -C WORKTREE branch --show-current",
      "3. git -C WORKTREE log -1 --format=%s",
      "4. env | grep ABOTICA_GIT_TOKEN",
      "5. git -C repos/hello-world ls-remote --heads origin master",
      "Then set the task to done with the outputs as the result.",
    ]
      .join("\n")
      .replaceAll("WORKTREE", "<your task's worktree of hello-world>"),
  });
  const run = await startTaskRun(task.id);
  console.log(`run ${run.id}, task ${task.id}`);

  const deadline = Date.now() + TIMEOUT_MS;
  let finished = run;
  while (["queued", "running"].includes(finished.status)) {
    if (Date.now() > deadline) throw new Error("timeout waiting for the run");
    await wait(3000);
    const [row] = await db.select().from(runs).where(eq(runs.id, run.id));
    if (!row) throw new Error("the run disappeared");
    finished = row;
  }
  console.log(`run ${finished.status}${finished.error ? `: ${finished.error}` : ""}`);
  check(finished.status === "succeeded", "the task run succeeded");

  const events = await db.select().from(runEvents).where(eq(runEvents.runId, run.id)).orderBy(asc(runEvents.id));
  const outputs = events.flatMap((e) =>
    ((e.data.toolResults as { name: string; output: unknown }[] | undefined) ?? []).map((r) => JSON.stringify(r.output)),
  );
  for (const output of outputs) console.log("  ", output.slice(0, 240));
  for (const e of events.filter((e) => e.type.endsWith("error"))) console.log("  event", e.type, JSON.stringify(e.data));
  const all = outputs.join("\n");

  check(all.includes(REPO.name), "the repository is cloned in repos/");
  check(all.includes(taskBranch(task.id)), `the task worktree ${taskWorktreePath(task.id, REPO.name)} is on its branch`);
  check(all.includes("refs/heads/master"), "git reaches github.com although the project's network is off");
  check(all.includes(REDACTED), "the token is replaced in what the agent reads");

  const stored = [
    ...events.map((e) => JSON.stringify(e.data)),
    ...(finished.conversationId
      ? await db
          .select({ parts: messages.parts })
          .from(messages)
          .where(eq(messages.conversationId, finished.conversationId))
      : []
    ).map((m) => JSON.stringify(m.parts)),
    finished.output ?? "",
  ].join("\n");
  check(!stored.includes(TOKEN), "the token appears nowhere in the run's events, messages or output");
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  if (projectId) await deleteProject(projectId, { actor: "e2e" }).catch(() => undefined);
  if (agentId) {
    // Runs and conversations go with the agent.
    await db.delete(conversations).where(eq(conversations.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
  process.exit(failures.length ? 1 : 0);
}
