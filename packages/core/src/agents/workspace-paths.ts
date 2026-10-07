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

export const repoPath = (repoName: string) => `${REPOS_DIR}/${repoName}`;

export const taskWorktreePath = (taskId: string, repoName: string) => `${WORK_DIR}/${taskId}/${repoName}`;

/**
 * A task's branch, the same in every repository and run. It comes from the task id alone, so a
 * renamed task keeps its branch and its open pull request.
 */
export const taskBranch = (taskId: string) => `abotica/task-${taskId.replace(/-/g, "").slice(0, 8)}`;
