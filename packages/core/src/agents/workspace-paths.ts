/**
 * Where Abotica puts stored files inside a sandbox workspace, relative to its working directory.
 * Pure, so the runner (which tells the model the path) and the sandbox session (which copies the
 * file) agree without either opening the other. Repositories get their own folders next to these,
 * so stored files never show up in their `git status`.
 */
import { safeFileName } from "../files/file-types";

/** Files of the conversation's messages and of the run's task. */
export const INPUTS_DIR = "inputs";
/** The project's knowledge files, read-only. */
export const KNOWLEDGE_DIR = "knowledge";

type FileRef = { id: string; name: string };

/**
 * A folder per file keeps its original name (two uploads called photo.jpg do not collide) and stays
 * the same across runs, so the model is told the path before anything is copied.
 */
const folderOf = (file: FileRef) => file.id.replace(/-/g, "").slice(0, 8);

export const inputPath = (file: FileRef) => `${INPUTS_DIR}/${folderOf(file)}/${safeFileName(file.name)}`;

export const knowledgePath = (file: FileRef) => `${KNOWLEDGE_DIR}/${folderOf(file)}/${safeFileName(file.name)}`;

/** Clones of the project's repositories. */
export const REPOS_DIR = "repos";
/** Worktrees of tasks, one folder per task. */
export const WORK_DIR = "work";

/** Full text of tool results that were cut for the model, one folder per run. */
export const TOOL_OUTPUT_DIR = "tool-output";

export const repoPath = (repoName: string) => `${REPOS_DIR}/${repoName}`;

export const taskWorktreePath = (taskId: string, repoName: string) => `${WORK_DIR}/${taskId}/${repoName}`;

/**
 * The checkout of one of `repoNames` that holds `file` (normalized, relative to the working directory):
 * its clone `repos/<name>` or a task's worktree `work/<taskId>/<name>`. Null for any other path.
 */
export function repoCheckoutOf(file: string, repoNames: string[]): string | null {
  const parts = file.split("/");
  const depth = parts[0] === REPOS_DIR ? 2 : parts[0] === WORK_DIR ? 3 : 0;
  if (!depth || parts.length <= depth || !repoNames.includes(parts[depth - 1]!)) return null;
  return parts.slice(0, depth).join("/");
}

/** The file with the full output of one tool call; a shell command has one per stream. */
/** A folder named by a task or run id, as under WORK_DIR and TOOL_OUTPUT_DIR; any other folder there is not Abotica's. */
export const isIdFolder = (name: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name);

export const toolOutputPath = (runId: string, toolCallId: string, stream?: "stdout" | "stderr") =>
  `${TOOL_OUTPUT_DIR}/${runId}/${safeFileName(toolCallId, "call")}${stream ? `.${stream}` : ""}.txt`;

/**
 * A task's branch, the same in every repository and run. It comes from the task id alone, so a
 * renamed task keeps its branch and its open pull request.
 */
export const taskBranch = (taskId: string) => `abotica/task-${taskId.replace(/-/g, "").slice(0, 8)}`;
