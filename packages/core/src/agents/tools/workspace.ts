import path from "node:path";
import { type Experimental_SandboxSession, type JSONValue, tool } from "ai";
import { z } from "zod";
import { fileUrl } from "../../files/file-types";
import { type FileOwner, saveFile } from "../../files/files";
import { type ImageMediaType, imageMediaType, imageSize } from "../../files/image-info";
import { FILE_MAX_BYTES } from "../../platform/limits";
import { logRunEvent } from "../../runs/run-lifecycle";
import type { Agent, RunContext } from "../context";
import { builtinPermission } from "../permissions";
import { nestedRepoInstructions } from "../repo-instructions";
import { capStreamText, fullOutputTarget, SAVED_TOOL_TEXT_MAX_CHARS } from "../tool-output";
import { blankToUndefined, clip, errorResult, NO_SANDBOX, type ToolFactory } from "./shared";
import { TOOL_CATALOG } from "./tool-catalog";
import { applyEdit, collectText, decodeText, readAtMost, sliceLines } from "./workspace-text";

/** Bytes of stdout and of stderr kept to save in full when the model's view is cut, as runCommand keeps. */
const FULL_OUTPUT_BYTES = 1024 * 1024;
/** Characters of file content returned by one file_read. */
const READ_CHARS = 30_000;
/** Largest file file_read and file_edit load. */
const TEXT_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Tools that work in the sandbox, so an agent with any of them gets one. Repo tools only add to them. */
const WORKSPACE_TOOL_NAMES = TOOL_CATALOG.filter((t) => t.group === "workspace" && !t.needsRepos).map((t) => t.name);

/** Workspace tools the agent's permissions do not deny. */
export function workspaceToolsOf(agent: Pick<Agent, "permissions" | "kind">): string[] {
  return WORKSPACE_TOOL_NAMES.filter((name) => builtinPermission(agent.permissions, name, agent) !== "deny");
}

const pathInput = z
  .string()
  .trim()
  .min(1)
  .describe("Relative to the workspace (e.g. report.md, out/chart.png) or absolute inside it.");

type Sandbox = Experimental_SandboxSession;

/**
 * Largest image file_read returns. Providers take about 5 MB of base64 per image, which is 3.75 MB
 * of file; past that the whole step would fail, so the agent is asked for a smaller copy instead.
 */
const IMAGE_MAX_BYTES = 3_750_000;

/** An image file_read returns, as base64; toModelOutput turns it into a file part the model sees. */
type ImageRead = {
  path: string;
  mediaType: ImageMediaType;
  bytes: number;
  width?: number;
  height?: number;
  image: string;
};

const isImageRead = (value: unknown): value is ImageRead =>
  typeof value === "object" && value !== null && typeof (value as ImageRead).image === "string";

/** An image the model can look at, or an error when it is too large for a provider to take. */
function imageRead(file: string, bytes: Uint8Array, mediaType: ImageMediaType): ImageRead | { error: string } {
  if (bytes.length > IMAGE_MAX_BYTES) {
    return {
      error: `Image ${file} is ${(bytes.length / 1_000_000).toFixed(1)} MB; file_read shows images up to ${IMAGE_MAX_BYTES / 1_000_000} MB. Save a smaller copy (e.g. \`convert ${file} -resize 50% small.jpg\`) and read that.`,
    };
  }
  const size = imageSize(bytes, mediaType);
  return {
    path: file,
    mediaType,
    bytes: bytes.length,
    ...size,
    image: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
  };
}

/**
 * A text file's content, or an error for the model when it is missing, binary or too large. With
 * `images` (file_read), a PNG, JPEG, GIF or WebP comes back as an image for the model to look at;
 * file_edit leaves it out, an image is not text to edit.
 */
async function readText(
  sandbox: Sandbox,
  file: string,
  abortSignal?: AbortSignal,
  { images = false }: { images?: boolean } = {},
): Promise<string | ImageRead | { error: string }> {
  const stream = await sandbox.readFile({ path: file, abortSignal });
  if (!stream) return { error: `File ${file} does not exist.` };
  const bytes = await readAtMost(stream, TEXT_FILE_MAX_BYTES);
  if (!bytes) {
    return {
      error: `File ${file} is larger than ${TEXT_FILE_MAX_BYTES / (1024 * 1024)} MB. Use shell_run with head, tail, sed or grep to read parts of it.`,
    };
  }
  const mediaType = images ? imageMediaType(bytes) : null;
  if (mediaType) return imageRead(file, bytes, mediaType);
  const text = decodeText(bytes);
  if (text === null) {
    const kind = images ? "a text file or an image" : "a text file";
    return { error: `File ${file} is not ${kind}. Inspect it with shell_run (file, xxd, or a script).` };
  }
  return text;
}

/**
 * What the model gets from file_read: an image as a file part after a line naming it, anything else
 * as JSON, as the AI SDK sends a tool result by default.
 */
function fileReadModelOutput({ output }: { output: unknown }) {
  if (!isImageRead(output)) return { type: "json" as const, value: output as JSONValue };
  const size = output.width && output.height ? `, ${output.width}x${output.height} px` : "";
  const kb = Math.max(1, Math.round(output.bytes / 1024));
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: `${output.path}: ${output.mediaType}${size}, ${kb} KB.` },
      {
        type: "file" as const,
        mediaType: output.mediaType,
        filename: path.posix.basename(output.path),
        data: { type: "data" as const, data: output.image },
      },
    ],
  };
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
 * Runs a shell command in the run's workspace and collects its output, cut to SAVED_TOOL_TEXT_MAX_CHARS
 * per stream (the workspace is there to keep the rest); a cut stream is saved in full (up to
 * FULL_OUTPUT_BYTES) and its file named.
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
      collectText(proc.stdout, SAVED_TOOL_TEXT_MAX_CHARS, FULL_OUTPUT_BYTES),
      collectText(proc.stderr, SAVED_TOOL_TEXT_MAX_CHARS, FULL_OUTPUT_BYTES),
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

  file_read: (ctx) =>
    tool({
      description:
        "Read a text file from your workspace. Optionally pass a line range (1-based, inclusive). Returns the content and the total number of lines; the first read in a repository folder also returns its instructions for coding agents (repoInstructions). An image (PNG, JPEG, GIF, WebP) is shown to you as a picture, e.g. a screenshot to check a page you built.",
      inputSchema: z.object({
        path: pathInput,
        startLine: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).optional()),
        endLine: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).optional()),
      }),
      execute: ({ path: file, startLine, endLine }, { abortSignal, experimental_sandbox: sandbox }) =>
        guarded(abortSignal, async () => {
          if (!sandbox) return NO_SANDBOX;
          const text = await readText(sandbox, file, abortSignal, { images: true });
          if (typeof text !== "string") return text;
          const { content, totalLines } = sliceLines(text, startLine, endLine);
          const shown = clip(content, READ_CHARS)!;
          const repoInstructions = await nestedRepoInstructions(ctx, file, {
            signal: abortSignal,
            onError: (error) => void logRunEvent(ctx.run.id, "sandbox-error", errorResult(error)).catch(() => {}),
          });
          return {
            path: file,
            content: shown,
            totalLines,
            ...(shown !== content && { note: "Content was cut. Read the rest with startLine and endLine." }),
            ...(repoInstructions && { repoInstructions }),
          };
        }),
      toModelOutput: fileReadModelOutput,
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
      description: `Give the user a file from your workspace (max ${FILE_MAX_BYTES / (1024 * 1024)} MB), including one another agent produced (under inputs/): it appears as a download in the conversation. When you work on a task, the file goes with the task's result to whoever delegated it. Use it for every file the user should get; do not paste long file contents into your answer.`,
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
