/**
 * The sandbox session of one run: which workspace, which policy, which skills, and the stored files
 * copied in (inputs and the project's knowledge). Nothing starts until a tool uses the session (it
 * opens lazily).
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { db, files, knowledgeItems, messages, runEvents, skillFiles, tasks } from "@abotica/db";
import { and, asc, eq, inArray } from "@abotica/db/orm";
import {
  type Bundle,
  createSandboxSession,
  type ManagedSandboxSession,
  runCommand,
  shellQuote,
  type Workspace,
} from "@abotica/sandbox";
import { env } from "../infra/env";
import { fileIdFromUrl } from "../files/file-types";
import { listFiles, readFileBytes, type StoredFile } from "../files/files";
import { FILE_MAX_BYTES } from "../platform/limits";
import { conversationWorkspaceKey, projectWorkspaceKey, touchWorkspace } from "../sandbox/sandbox";
import { currentSandboxBackend } from "../sandbox/sandbox-runtime";
import { egressFor, setupEgressFor } from "../sandbox/sandbox-policy";
import type { RunContext } from "./context";
import { prepareRepos, repoGitEnv, repoHosts } from "./repo-workspace";
import { workspaceToolsOf } from "./tools/workspace";
import { workspaceDescription } from "./workspace-description";
import { INPUTS_DIR, inputPath, KNOWLEDGE_DIR, knowledgePath } from "./workspace-paths";

/** One marker file per copied input file, named by its id. */
const COPIED_DIR = ".abotica/inputs-copied";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Skills as read-only folders; the hash covers every path and content, so edits resync them. */
async function skillBundles(skills: RunContext["skills"]): Promise<Bundle[]> {
  if (!skills.length) return [];
  const rows = await db
    .select({ skillId: skillFiles.skillId, path: skillFiles.path, content: skillFiles.content })
    .from(skillFiles)
    .where(
      inArray(
        skillFiles.skillId,
        skills.map((s) => s.id),
      ),
    )
    .orderBy(asc(skillFiles.path));
  return skills.flatMap((skill) => {
    const files = rows.filter((r) => r.skillId === skill.id);
    if (!files.length) return [];
    return [
      {
        name: skill.slug,
        hash: sha(JSON.stringify(files.map((f) => [f.path, f.content]))),
        files: files.map((f) => ({ path: f.path, content: f.content, executable: f.content.startsWith("#!") })),
      },
    ];
  });
}

/** File ids of the conversation's user messages (the user's attachments and delegation reports). */
async function messageFileIds(conversationId: string): Promise<string[]> {
  const rows = await db
    .select({ parts: messages.parts })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user")))
    .orderBy(asc(messages.createdAt));
  const origins = [env().APP_URL];
  return rows.flatMap((row) =>
    row.parts.flatMap((part) => {
      const p = part as { type?: string; url?: unknown };
      const id = p.type === "file" && typeof p.url === "string" ? fileIdFromUrl(p.url, origins) : null;
      return id ? [id] : [];
    }),
  );
}

/** Files of the conversation's messages, whoever owns them, and of the run's task; each once. */
async function inputFiles(ctx: RunContext): Promise<StoredFile[]> {
  const ids = ctx.run.conversationId ? await messageFileIds(ctx.run.conversationId) : [];
  const [fromMessages, fromTask] = await Promise.all([
    ids.length
      ? db
          .select()
          .from(files)
          .where(inArray(files.id, [...new Set(ids)]))
      : [],
    ctx.run.taskId ? listFiles({ taskId: ctx.run.taskId }) : [],
  ]);
  const byId = new Map([...fromMessages, ...fromTask].map((f) => [f.id, f]));
  return [...byId.values()];
}

/**
 * Writes bytes to a workspace file through the sandbox, so permissions apply as for the agent. The
 * bytes go to a temporary file first: a copy that fails halfway never looks like a finished one.
 * `after` runs once the file is in place (a marker, a chmod).
 */
async function writeWorkspaceFile(
  workspace: Workspace,
  file: string,
  data: Uint8Array,
  after: string,
  signal: AbortSignal,
) {
  const partial = `${file}.partial`;
  const proc = await workspace.exec({
    command: `mkdir -p ${shellQuote(path.posix.dirname(file))} && cat > ${shellQuote(partial)} && mv -f ${shellQuote(partial)} ${shellQuote(file)} && ${after}`,
    egress: [],
    stdin: "pipe",
    signal,
    timeoutMs: 120_000,
  });
  const writer = proc.stdin!.getWriter();
  await writer.write(data);
  await writer.close();
  void proc.stdout.cancel().catch(() => {});
  const stderr = new Response(proc.stderr).text();
  const { exitCode } = await proc.wait();
  if (exitCode !== 0) throw new Error(`Copying ${file} failed (${exitCode}): ${(await stderr).slice(0, 500)}`);
}

async function listing(workspace: Workspace, command: string, signal: AbortSignal): Promise<string[]> {
  const result = await runCommand(workspace, { command, egress: [], signal, timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr.slice(0, 500)}`);
  return result.stdout.split("\n").filter(Boolean);
}

/**
 * Copies input files to `inputPath(file)` once per workspace and file: a marker per file id means a
 * file the agent deleted or changed is not copied again. Failures are logged, never fatal.
 */
async function copyInputs(ctx: RunContext, workspace: Workspace, signal: AbortSignal) {
  const sources = await inputFiles(ctx);
  if (!sources.length) return;
  const copied = new Set(await listing(workspace, `mkdir -p ${INPUTS_DIR} ${COPIED_DIR} && ls -1A ${COPIED_DIR}`, signal));
  for (const file of sources) {
    if (copied.has(file.id) || signal.aborted) continue;
    try {
      const data = await readFileBytes(file.id);
      if (!data || data.byteLength > FILE_MAX_BYTES) continue;
      await writeWorkspaceFile(workspace, inputPath(file), data, `touch ${shellQuote(`${COPIED_DIR}/${file.id}`)}`, signal);
    } catch (error) {
      console.error(`[sandbox] copying input ${file.name} into ${workspace.key} failed:`, error);
    }
  }
}

/**
 * Keeps `knowledge/` equal to the project's knowledge files: missing ones are copied, anything else
 * (a file whose knowledge item is gone, one the agent put there) is removed. The files are read-only;
 * that guards against mistakes, it is not a security boundary. Folders stay writable so the
 * workspace can still be deleted from the host.
 */
async function syncKnowledge(projectId: string, workspace: Workspace, signal: AbortSignal) {
  const rows = await db
    .select({ file: files })
    .from(files)
    .innerJoin(knowledgeItems, eq(knowledgeItems.id, files.knowledgeItemId))
    .where(eq(knowledgeItems.projectId, projectId));
  const wanted = new Map(rows.map(({ file }) => [knowledgePath(file), file]));
  const present = await listing(
    workspace,
    `if [ -d ${KNOWLEDGE_DIR} ]; then find ${KNOWLEDGE_DIR} -mindepth 1 ! -type d -print; fi`,
    signal,
  );
  const stale = present.filter((p) => !wanted.has(p));
  if (stale.length) {
    await listing(
      workspace,
      `rm -f ${stale.map(shellQuote).join(" ")} && find ${KNOWLEDGE_DIR} -mindepth 1 -type d -empty -delete`,
      signal,
    );
  }
  for (const [target, file] of wanted) {
    if (present.includes(target) || signal.aborted) continue;
    try {
      const data = await readFileBytes(file.id);
      if (data) await writeWorkspaceFile(workspace, target, data, `chmod a-w ${shellQuote(target)}`, signal);
    } catch (error) {
      console.error(`[sandbox] copying knowledge file ${file.name} into ${workspace.key} failed:`, error);
    }
  }
}

/** Of the given task ids, the tasks that are done or no longer exist. */
async function finishedTasks(taskIds: string[]): Promise<Set<string>> {
  const open = await db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(inArray(tasks.id, taskIds));
  const active = new Set(open.filter((t) => t.status !== "done").map((t) => t.id));
  return new Set(taskIds.filter((id) => !active.has(id)));
}

/** Git identity of an agent's commits; `.invalid` is reserved, so the address never reaches anyone. */
const gitAuthor = (agent: RunContext["agent"]) => ({ name: agent.name, email: `${agent.slug}@agents.abotica.invalid` });

/**
 * The run's sandbox session, or null when no backend is available or the agent has no workspace
 * tool. Projects share one workspace; runs without a project use their conversation's.
 */
export async function openRunSandbox(ctx: RunContext, signal: AbortSignal): Promise<ManagedSandboxSession | null> {
  const backend = currentSandboxBackend();
  if (!backend || !workspaceToolsOf(ctx.agent).length) return null;
  const conversationId = ctx.run.conversationId;
  if (!ctx.project && !conversationId) return null;
  const key = ctx.project ? projectWorkspaceKey(ctx.project.id) : conversationWorkspaceKey(conversationId!);
  const policy = ctx.project?.sandbox ?? ctx.settings.sandbox.defaults;
  const bundles = await skillBundles(ctx.skills);
  const commandTimeoutSec = ctx.settings.sandbox.commandTimeoutSec;
  const repos = ctx.repos;
  const gitEnv = repoGitEnv(repos, gitAuthor(ctx.agent));
  const egress = egressFor(policy.network);
  return createSandboxSession({
    backend,
    spec: { key, bundles },
    // Git reaches the repositories' hosts whatever the network setting.
    egress: egress === "public" ? egress : [...new Set([...egress, ...repoHosts(repos)])],
    setupEgress: setupEgressFor(policy.network),
    packages: policy.packages,
    env: gitEnv,
    description: workspaceDescription({
      paths: backend.pathsFor(key),
      scope: ctx.project ? "project" : "conversation",
      network: policy.network,
      packages: policy.packages,
      skills: bundles.map((b) => b.name),
      commandTimeoutSec,
      repos,
      taskId: ctx.run.taskId,
      root: workspaceToolsOf(ctx.agent).includes("shell_run_root"),
    }),
    commandTimeoutMs: commandTimeoutSec * 1000,
    signal,
    onPrepare: async (workspace: Workspace) => {
      await touchWorkspace(key).catch(() => {});
      await copyInputs(ctx, workspace, signal).catch((error: unknown) =>
        console.error(`[sandbox] preparing inputs of ${key} failed:`, error),
      );
      if (ctx.project) {
        await syncKnowledge(ctx.project.id, workspace, signal).catch((error: unknown) =>
          console.error(`[sandbox] syncing knowledge of ${key} failed:`, error),
        );
      }
      await prepareRepos(workspace, {
        repos,
        env: gitEnv,
        taskId: ctx.run.taskId,
        finishedTasks,
        signal,
        // Shown in the run's timeline: the agent may meet a missing clone or worktree.
        onError: (message) => {
          console.error(`[sandbox] ${key}: ${message}`);
          void db
            .insert(runEvents)
            .values({ runId: ctx.run.id, type: "sandbox-error", data: { error: message } })
            .catch(() => {});
        },
      }).catch((error: unknown) => console.error(`[sandbox] preparing the repositories of ${key} failed:`, error));
    },
  });
}
