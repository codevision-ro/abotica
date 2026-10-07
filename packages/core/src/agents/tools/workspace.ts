import path from "node:path";
import { type Experimental_SandboxSession, tool } from "ai";
import { z } from "zod";
import { fileUrl } from "../../files/file-types";
import { type FileOwner, saveFile } from "../../files/files";
import { FILE_MAX_BYTES } from "../../platform/limits";
import type { Agent, RunContext } from "../context";
import { builtinPermission } from "../permissions";
import { capStreamText, fullOutputTarget, TOOL_TEXT_MAX_CHARS } from "../tool-output";
import { blankToUndefined, clip, errorResult, type ToolFactory } from "./shared";
import { TOOL_CATALOG } from "./tool-catalog";
import { applyEdit, collectText, decodeText, readAtMost, sliceLines } from "./workspace-text";

/** Bytes of stdout and of stderr kept to save in full when the model's view is cut, as runCommand keeps. */
const FULL_OUTPUT_BYTES = 1024 * 1024;
/** Characters of file content returned by one file_read. */
const READ_CHARS = 30_000;
/** Largest file file_read and file_edit load. */
const TEXT_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Tools that work in the sandbox, so an agent with any of them gets one. Repo tools only add to them. */
export const WORKSPACE_TOOL_NAMES = TOOL_CATALOG.filter((t) => t.group === "workspace" && !t.needsRepos).map((t) => t.name);

/** Workspace tools the agent's permissions do not deny. */
export function workspaceToolsOf(agent: Pick<Agent, "permissions" | "isOrchestrator">): string[] {
  // No workspace tool is a manager tool, so managing a project changes nothing here.
  const opts = { isOrchestrator: agent.isOrchestrator, isManager: false };
  return WORKSPACE_TOOL_NAMES.filter((name) => builtinPermission(agent.permissions, name, opts) !== "deny");
}

const NO_SANDBOX = { error: "The workspace is not available in this run." };

const pathInput = z
  .string()
  .trim()
  .min(1)
  .describe("Relative to the workspace (e.g. report.md, out/chart.png) or absolute inside it.");

type Sandbox = Experimental_SandboxSession;

/** A text file's content, or an error for the model when it is missing, binary or too large. */
async function readText(sandbox: Sandbox, file: string, abortSignal?: AbortSignal): Promise<string | { error: string }> {
  const stream = await sandbox.readFile({ path: file, abortSignal });
  if (!stream) return { error: `File ${file} does not exist.` };
  const bytes = await readAtMost(stream, TEXT_FILE_MAX_BYTES);
  if (!bytes) {
    return { error: `File ${file} is larger than 10 MB. Use shell_run with head, tail, sed or grep to read parts of it.` };
  }
  const text = decodeText(bytes);
  if (text === null) {
    return { error: `File ${file} is not a text file. Inspect it with shell_run (file, xxd, or a script).` };
  }
  return text;
}

/** A workspace file's bytes (at most FILE_MAX_BYTES), or an error for the model. */
export async function readWorkspaceBytes(
  sandbox: Sandbox,
  file: string,
  abortSignal?: AbortSignal,
): Promise<Uint8Array | { error: string }> {
  const stream = await sandbox.readFile({ path: file, abortSignal });
  if (!stream) return { error: `File ${file} does not exist.` };
  const data = await readAtMost(stream, FILE_MAX_BYTES);
  if (!data)
    return { error: `File ${file} is larger than ${FILE_MAX_BYTES / (1024 * 1024)} MB. Compress or split it first.` };
  return data;
}

/**
 * Who owns a file the run shares: the task when the run works on one (the delegating agent gets it
 * with the task's report), otherwise the run's conversation, where the user sees it.
 */
const shareOwner = (run: RunContext["run"]): FileOwner | null =>
  run.taskId ? { taskId: run.taskId } : run.conversationId ? { conversationId: run.conversationId } : null;

/** Runs the tool body; a cancelled run still stops, other failures go back to the model. */
async function guarded<T>(abortSignal: AbortSignal | undefined, body: () => Promise<T>) {
  try {
    return await body();
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    return errorResult(error);
  }
}

const shellInput = (ctx: RunContext) =>
  z.object({
    command: z.string().min(1),
    timeoutSeconds: z.preprocess(
      blankToUndefined,
      z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .describe(`Stop the command after this many seconds (at most ${ctx.settings.sandbox.commandTimeoutSec}).`),
    ),
  });

/**
 * Runs a shell command in the run's workspace and collects its output, cut to TOOL_TEXT_MAX_CHARS
 * per stream; a cut stream is saved in full (up to FULL_OUTPUT_BYTES) and its file named.
 */
function runShell(
  ctx: RunContext,
  { command, timeoutSeconds }: { command: string; timeoutSeconds?: number },
  user: "sandbox" | "root",
  call: { toolCallId: string; abortSignal?: AbortSignal },
) {
  const { abortSignal } = call;
  return guarded(abortSignal, async () => {
    const sandbox = ctx.sandbox;
    if (!sandbox) return NO_SANDBOX;
    const limit = ctx.settings.sandbox.commandTimeoutSec;
    const seconds = Math.min(timeoutSeconds ?? limit, limit);
    const proc = await sandbox.spawn({ command, abortSignal, user });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void proc.kill();
    }, seconds * 1000);
    // Saving the output happens after the timer: the command is over, so it cannot count as timed out.
    const [stdout, stderr, { exitCode }] = await Promise.all([
      collectText(proc.stdout, TOOL_TEXT_MAX_CHARS, FULL_OUTPUT_BYTES),
      collectText(proc.stderr, TOOL_TEXT_MAX_CHARS, FULL_OUTPUT_BYTES),
      proc.wait(),
    ]).finally(() => clearTimeout(timer));
    const workspace = { sandbox, runId: ctx.run.id };
    const [out, err] = await Promise.all([
      capStreamText(stdout, fullOutputTarget(workspace, call, "stdout")),
      capStreamText(stderr, fullOutputTarget(workspace, call, "stderr")),
    ]);
    return {
      exitCode,
      stdout: out.text,
      stderr: err.text,
      timedOut,
      ...(out.file && { stdoutFile: out.file }),
      ...(err.file && { stderrFile: err.file }),
    };
  });
}

export const workspaceTools: Record<string, ToolFactory> = {
  shell_run: (ctx) =>
    tool({
      description:
        "Run a bash command in your workspace. Returns the exit code, stdout and stderr (long output keeps its start and end). Every call starts a fresh shell in the workspace: files persist, cd and variables do not.",
      inputSchema: shellInput(ctx),
      execute: (input, call) => runShell(ctx, input, "sandbox", call),
    }),

  shell_run_root: (ctx) =>
    tool({
      description:
        "Run a bash command as root in your workspace, to install system packages (apt-get update && apt-get install -y <package>). It reaches the package registries whatever the network setting. Files it leaves in the workspace go back to you afterwards. Use shell_run for everything else.",
      inputSchema: shellInput(ctx),
      execute: (input, call) => runShell(ctx, input, "root", call),
    }),

  file_read: () =>
    tool({
      description:
        "Read a text file from your workspace. Optionally pass a line range (1-based, inclusive). Returns the content and the total number of lines.",
      inputSchema: z.object({
        path: pathInput,
        startLine: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).optional()),
        endLine: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).optional()),
      }),
      execute: ({ path: file, startLine, endLine }, { abortSignal, experimental_sandbox: sandbox }) =>
        guarded(abortSignal, async () => {
          if (!sandbox) return NO_SANDBOX;
          const text = await readText(sandbox, file, abortSignal);
          if (typeof text !== "string") return text;
          const { content, totalLines } = sliceLines(text, startLine, endLine);
          const shown = clip(content, READ_CHARS)!;
          return {
            path: file,
            content: shown,
            totalLines,
            ...(shown !== content && { note: "Content was cut. Read the rest with startLine and endLine." }),
          };
        }),
    }),

  file_write: () =>
    tool({
      description: "Create or overwrite a file in your workspace with the given text. Parent folders are created.",
      inputSchema: z.object({ path: pathInput, content: z.string() }),
      execute: ({ path: file, content }, { abortSignal, experimental_sandbox: sandbox }) =>
        guarded(abortSignal, async () => {
          if (!sandbox) return NO_SANDBOX;
          await sandbox.writeTextFile({ path: file, content, abortSignal });
          return { path: file, bytes: Buffer.byteLength(content) };
        }),
    }),

  file_edit: () =>
    tool({
      description:
        "Replace text in a file in your workspace. oldText must match exactly once (copy it from file_read, with its whitespace) unless replaceAll is set.",
      inputSchema: z.object({
        path: pathInput,
        oldText: z.string(),
        newText: z.string(),
        replaceAll: z.preprocess(blankToUndefined, z.boolean().optional()),
      }),
      execute: ({ path: file, oldText, newText, replaceAll }, { abortSignal, experimental_sandbox: sandbox }) =>
        guarded(abortSignal, async () => {
          if (!sandbox) return NO_SANDBOX;
          const text = await readText(sandbox, file, abortSignal);
          if (typeof text !== "string") return text;
          const edit = applyEdit(text, oldText, newText, replaceAll);
          if ("error" in edit) return edit;
          await sandbox.writeTextFile({ path: file, content: edit.content, abortSignal });
          return { path: file, replacements: edit.replacements };
        }),
    }),

  file_share: (ctx) =>
    tool({
      description:
        "Give the user a file from your workspace (max 50 MB), including one another agent produced (under inputs/): it appears as a download in the conversation. When you work on a task, the file goes with the task's result to whoever delegated it. Use it for every file the user should get; do not paste long file contents into your answer.",
      inputSchema: z.object({
        path: pathInput,
        name: z.preprocess(
          blankToUndefined,
          z.string().trim().max(200).optional().describe("File name the user sees; defaults to the file's own name."),
        ),
      }),
      execute: ({ path: file, name }, { abortSignal, experimental_sandbox: sandbox }) =>
        guarded(abortSignal, async () => {
          if (!sandbox) return NO_SANDBOX;
          const owner = shareOwner(ctx.run);
          if (!owner) return { error: "This run has no conversation or task to share the file with." };
          const data = await readWorkspaceBytes(sandbox, file, abortSignal);
          if ("error" in data) return data;
          const saved = await saveFile({
            name: name || path.posix.basename(file),
            data,
            source: "agent",
            owner,
            runId: ctx.run.id,
            agentId: ctx.agent.id,
          });
          return {
            id: saved.id,
            name: saved.name,
            mimeType: saved.mimeType,
            size: saved.size,
            url: fileUrl(saved.id),
          };
        }),
    }),
};
