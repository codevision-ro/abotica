/**
 * Long tool output: the model reads its start and its end with a notice in place of the middle,
 * and the full text is saved in the run's workspace (`tool-output/<runId>`), where the agent reads
 * it back with file_read or grep. Tools cap in `execute`, so the stored message, the run event and
 * every later replay hold the short text too.
 */
import type { Experimental_SandboxSession } from "ai";
import { type CollectedText, HeadTailText, type TextCut } from "./tools/workspace-text";
import { toolOutputPath } from "./workspace-paths";

/** Characters of one tool result the model reads, the same for every tool and model. */
export const TOOL_TEXT_MAX_CHARS = 30_000;
/** How long the full output of a run stays in its workspace after the run ended. */
export const TOOL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type CappedText = { text: string; cut: TextCut | null };

/** The line in place of a cut middle: the file with the full text, or that nothing else was kept. */
export const cutNotice = (omitted: number, fullPath: string | null) =>
  fullPath
    ? `[... ${omitted} characters cut. Full output in your workspace: ${fullPath} ...]`
    : `[... ${omitted} characters cut and not kept. Re-run with narrower arguments to see them ...]`;

const headTail = (max: number) => new HeadTailText(Math.floor(max / 2), Math.ceil(max / 2));

const shown = (view: HeadTailText, fullPath: string | null): CappedText => ({
  text: view.text((omitted) => cutNotice(omitted, fullPath)),
  cut: view.cut(),
});

/**
 * Keeps half of `max` characters from the start of a text and half from its end, with a notice in
 * between naming the file with the full text (`fullPath`). A text within `max` comes back as it is.
 */
export function capText(text: string, max = TOOL_TEXT_MAX_CHARS, fullPath: string | null = null): CappedText {
  const view = headTail(max);
  view.push(text);
  return shown(view, fullPath);
}

/** The run whose workspace keeps the full output of its tool calls. */
export type ToolOutputWorkspace = {
  sandbox: Pick<Experimental_SandboxSession, "writeTextFile">;
  runId: string;
};

/** Where the full text of one tool call goes. */
export type FullOutputTarget = {
  sandbox: ToolOutputWorkspace["sandbox"];
  path: string;
  abortSignal?: AbortSignal;
};

/** The file for a tool call's full output, or null when the run has no workspace. */
export function fullOutputTarget(
  workspace: ToolOutputWorkspace | null | undefined,
  call: { toolCallId: string; abortSignal?: AbortSignal },
  stream?: "stdout" | "stderr",
): FullOutputTarget | null {
  if (!workspace) return null;
  return {
    sandbox: workspace.sandbox,
    path: toolOutputPath(workspace.runId, call.toolCallId, stream),
    abortSignal: call.abortSignal,
  };
}

/** Writes a tool's full output into the workspace: its path, or null when writing failed. */
export async function saveFullOutput(target: FullOutputTarget, text: string): Promise<string | null> {
  try {
    await target.sandbox.writeTextFile({ path: target.path, content: text, abortSignal: target.abortSignal });
    return target.path;
  } catch (error) {
    // A cancelled run still stops; any other failure leaves the model the cut text without a file.
    if (target.abortSignal?.aborted) throw error;
    console.error(`[tools] saving the full output to ${target.path} failed:`, error);
    return null;
  }
}

/** Capped text, and the workspace file with the full text when it was cut and saved. */
export type CappedOutput = CappedText & { file: string | null };

async function capView(view: HeadTailText, full: () => string, target: FullOutputTarget | null): Promise<CappedOutput> {
  if (!view.cut()) return { ...shown(view, null), file: null };
  const file = target ? await saveFullOutput(target, full()) : null;
  return { ...shown(view, file), file };
}

/** Caps a tool's text at TOOL_TEXT_MAX_CHARS; when it was cut, the full text goes to `target` first. */
export function capToolText(text: string, target: FullOutputTarget | null): Promise<CappedOutput> {
  const view = headTail(TOOL_TEXT_MAX_CHARS);
  view.push(text);
  return capView(view, () => text, target);
}

/** Caps a stream a command printed; the saved file says so when the stream outgrew what was kept. */
export function capStreamText(collected: CollectedText, target: FullOutputTarget | null): Promise<CappedOutput> {
  const full = () =>
    collected.complete ? collected.full() : `${collected.full()}\n[... the output went on; this file holds its start ...]`;
  return capView(collected.view, full, target);
}

/**
 * Of the runs with a folder under tool-output, those whose folder goes: runs that ended more than
 * TOOL_OUTPUT_RETENTION_MS before `now`, and runs that no longer exist. Unfinished runs keep theirs.
 */
export function expiredToolOutputs(runIds: string[], runs: { id: string; finishedAt: Date | null }[], now: Date): string[] {
  const finishedAt = new Map(runs.map((run) => [run.id, run.finishedAt]));
  return runIds.filter((id) => {
    if (!finishedAt.has(id)) return true;
    const ended = finishedAt.get(id);
    return ended != null && now.getTime() - ended.getTime() > TOOL_OUTPUT_RETENTION_MS;
  });
}
