import { agents, conversations, db, runEvents, runs } from "@abotica/db";
import { asc, eq } from "@abotica/db/orm";
import {
  createAgentFromTemplate,
  createProject,
  createTask,
  deleteProject,
  getSandboxStatus,
  startTaskRun,
} from "../src/index";
import { wait } from "./e2e-shared";

/**
 * End-to-end check of what a project workspace offers for real work: a specialist starts MySQL,
 * creates a Laravel app with Composer, migrates it on MySQL, installs a system package as root,
 * hands the file root made back to the sandbox user, and gets pnpm through corepack. The project's
 * network is the default one (package registries only). Needs the worker running with the sandbox
 * (docker compose) and a provider key.
 * Usage: pnpm --filter @abotica/core e2e:stack (E2E_PROVIDER and E2E_MODEL pick the model, default DeepSeek)
 */
const MODEL = { provider: process.env.E2E_PROVIDER ?? "deepseek", model: process.env.E2E_MODEL ?? "deepseek-v4-flash" };
const TIMEOUT_MS = 20 * 60_000;

/**
 * Each step: the tool, the exact command, a part of it that identifies the call (models sometimes
 * retype quotes), and what its output must contain besides exit code 0.
 */
const STEPS = [
  {
    tool: "shell_run",
    command: `services start mysql && mysql -h 127.0.0.1 -u root -e "CREATE DATABASE IF NOT EXISTS laravel"`,
    marker: "services start mysql",
    expect: "127.0.0.1:3306",
    label: "MySQL starts as the sandbox user",
  },
  {
    tool: "shell_run",
    command:
      "composer create-project --no-interaction --prefer-dist --no-progress laravel/laravel app && test -f app/vendor/autoload.php && echo composer-ok",
    marker: "composer create-project",
    expect: "composer-ok",
    label: "Composer installs a Laravel app through Packagist and GitHub",
  },
  {
    tool: "shell_run",
    command:
      "cd app && sed -i -e 's/^DB_CONNECTION=.*/DB_CONNECTION=mysql/' -e 's/^# DB_/DB_/' .env && php artisan migrate --force",
    marker: "php artisan migrate",
    expect: "create_users_table",
    label: "Laravel migrates on MySQL",
  },
  {
    tool: "shell_run_root",
    command: "apt-get update -qq && apt-get install -y -qq php-redis && php -m | grep -ix redis",
    marker: "php-redis",
    expect: "redis",
    label: "root installs a system package with apt",
  },
  {
    tool: "shell_run_root",
    command: "touch /workspace/made-by-root && echo root-ok",
    marker: "made-by-root",
    expect: "root-ok",
    label: "root writes into the workspace",
  },
  {
    tool: "shell_run",
    command: "stat -c owner=%u /workspace/made-by-root",
    marker: "stat -c",
    expect: "owner=1000",
    label: "the file root made belongs to the sandbox user",
  },
  {
    tool: "shell_run",
    command: "pnpm --version",
    marker: "pnpm --version",
    expect: ".",
    label: "pnpm comes through corepack",
  },
] as const;

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
  const specialist = await createAgentFromTemplate("template-software-engineer", { name: "E2E Stack developer" });
  agentId = specialist.id;
  await db
    .update(agents)
    .set({ ...MODEL, fallbacks: [] })
    .where(eq(agents.id, specialist.id));
  const project = await createProject({
    name: `E2E Stack ${Date.now().toString(36)}`,
    memberIds: [specialist.id],
    managerAgentId: null,
  });
  projectId = project.id;
  const task = await createTask({
    title: "Check the workspace stack",
    projectId: project.id,
    assigneeAgentId: specialist.id,
    description: [
      "Run these commands in order, each exactly as written and in its own call, with the tool named before it. Do not change them, do not add commands, and do not stop at a failure: run every one, then set the task to done with their outputs as the result.",
      ...STEPS.map((step, i) => `${i + 1}. ${step.tool} (timeoutSeconds 300): ${step.command}`),
    ].join("\n"),
  });
  const run = await startTaskRun(task.id);
  console.log(`run ${run.id}, task ${task.id}`);

  const deadline = Date.now() + TIMEOUT_MS;
  let finished = run;
  while (["queued", "running"].includes(finished.status)) {
    if (Date.now() > deadline) throw new Error("timeout waiting for the run");
    await wait(5000);
    const [row] = await db.select().from(runs).where(eq(runs.id, run.id));
    if (!row) throw new Error("the run disappeared");
    finished = row;
  }
  console.log(`run ${finished.status}${finished.error ? `: ${finished.error}` : ""}`);
  check(finished.status === "succeeded", "the task run succeeded");

  const events = await db.select().from(runEvents).where(eq(runEvents.runId, run.id)).orderBy(asc(runEvents.id));
  const calls = events.flatMap(
    (e) => (e.data.toolCalls as { id: string; name: string; input: { command?: string } }[] | undefined) ?? [],
  );
  const results = new Map(
    events.flatMap((e) =>
      ((e.data.toolResults as { id: string; output: unknown }[] | undefined) ?? []).map((r) => [r.id, r.output]),
    ),
  );
  for (const step of STEPS) {
    // The last call of the step, in case the agent ran it again.
    const call = calls.findLast((c) => c.name === step.tool && c.input.command?.includes(step.marker));
    const output = call ? (results.get(call.id) as { exitCode?: number } | undefined) : undefined;
    const text = JSON.stringify(output ?? "");
    const ok = output?.exitCode === 0 && text.includes(step.expect);
    if (!ok) console.log(`   ${step.tool}: ${call ? text.slice(-800) : "not called"}`);
    check(ok, step.label);
  }
  if (failures.length) {
    for (const c of calls) console.log(`   call ${c.name}: ${JSON.stringify(c.input).slice(0, 300)}`);
  }
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
