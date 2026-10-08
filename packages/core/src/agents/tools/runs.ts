import path from "node:path";
import { agents, approvals, db, files, runEvents, runs, tasks } from "@abotica/db";
import { isUserError } from "@abotica/i18n";
import { type Experimental_SandboxSession, tool } from "ai";
import { and, desc, eq, gte, inArray, isNull, ne, or } from "@abotica/db/orm";
import { z } from "zod";
import { audit } from "../../platform/audit";
import { answersUser, loadDelegationProject, MAX_REDELEGATIONS, redelegateTask } from "../../tasks/delegation";
import { deleteFile, readFileBytes, saveFile } from "../../files/files";
import { cancelRun } from "../../runs/runs";
import { startDelegatedTask } from "../../tasks/delegation-slots";
import {
  activeTaskRun,
  createTask,
  type FailureStreak,
  isActiveTaskRunConflict,
  pendingDependencies,
  type Task,
  TaskCircuitOpenError,
  taskFailureStreak,
  TASK_PRIORITIES,
  updateTask,
} from "../../tasks/tasks";
import { checkDelegationTarget, delegationProjectId } from "../../tasks/team-rules";
import type { RunContext } from "../context";
import { planHandover } from "./delegate-files";
import {
  actorOf,
  agentBySlug,
  blankToUndefined,
  clip,
  optionalDateTime,
  optionalId,
  optionalText,
  closedProjects,
  errorResult,
  runContentClosed,
  type ToolFactory,
} from "./shared";
import { withhold, withholdClosed } from "./withheld";
import { readWorkspaceBytes } from "./workspace";

const RUN_STATUSES = ["queued", "running", "waiting_approval", "succeeded", "failed", "cancelled"] as const;
const STEP_LIMIT = 8;

type StepEvent = { step?: number; text?: string; toolCalls?: { name: string }[] };

type Handover = { path: string; name: string; data: Uint8Array };

/** Reads the files to hand over from the delegating agent's workspace; any problem fails them all. */
async function readHandover(
  paths: string[],
  sandbox: Experimental_SandboxSession | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<Handover[] | { error: string }> {
  if (!paths.length) return [];
  if (!sandbox) return { error: "Your workspace is not available in this run, so no files can be handed over." };
  const out: Handover[] = [];
  for (const file of new Set(paths)) {
    try {
      const data = await readWorkspaceBytes(sandbox, file, abortSignal);
      if ("error" in data) return { error: `${data.error} Nothing was delegated.` };
      out.push({ path: file, name: path.posix.basename(file), data });
    } catch (error) {
      if (abortSignal?.aborted) throw error;
      return {
        error: `Reading ${file} failed: ${error instanceof Error ? error.message : String(error)}. Nothing was delegated.`,
      };
    }
  }
  return out;
}

/** Files delegating agents handed to the task before, with these names (not what its own runs produced). */
async function handedOverBefore(taskId: string, names: string[]) {
  if (!names.length) return [];
  const rows = await db
    .select({ id: files.id, name: files.name })
    .from(files)
    .leftJoin(runs, eq(runs.id, files.runId))
    .where(
      and(
        eq(files.taskId, taskId),
        eq(files.source, "agent"),
        inArray(files.name, names),
        or(isNull(runs.taskId), ne(runs.taskId, taskId)),
      ),
    );
  return Promise.all(rows.map(async (r) => ({ ...r, data: await readFileBytes(r.id) })));
}

/** Stores the handed-over files for the task, then drops the earlier versions they replace. */
async function storeHandover(ctx: RunContext, taskId: string, plan: { save: Handover[]; replace: string[] }) {
  for (const file of plan.save) {
    await saveFile({
      name: file.name,
      data: file.data,
      source: "agent",
      owner: { taskId },
      runId: ctx.run.id,
      agentId: ctx.agent.id,
    });
  }
  for (const id of plan.replace) await deleteFile(id);
}

/**
 * A run working on a task of its own delegates parts of it: the new task is a subtask of that one, so the
 * work shows under it. Only within the same project, where a subtask belongs (see task_create).
 */
async function ownTaskParent(ctx: RunContext, projectId: string | null): Promise<string | null> {
  if (!ctx.run.taskId) return null;
  const [own] = await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, ctx.run.taskId));
  return own && own.projectId === projectId ? ctx.run.taskId : null;
}

/** The task's runs keep failing: the delegator reports it instead of trying again (see failureStreak). */
const circuitOpen = (taskId: string, streak: FailureStreak) => ({
  error: `Task ${taskId} is stopped: its last ${streak.failures} run(s) failed (${streak.reason ?? "no reason recorded"}). Starting it again would fail the same way. Tell the user what failed; only they can start it again, from the task page, once the cause is fixed.`,
});

/** The mechanics of delegating; whom to delegate to and what a brief holds is in the kind prompts. */
const DELEGATE =
  "Hand a task to an agent and start it right away (or once its dependencies are done, or once a place frees up when too many of your delegated tasks run at once). The agent sees neither your conversation nor your workspace: the description holds what it needs, files the files. To retry or reassign an existing task (e.g. a blocked one), send its taskId instead of a title and description. When the work finishes, its result arrives here as an automatic notice with the files it produced: end your turn after delegating and do not poll.";

/**
 * Said with every started delegation, at the moment the model decides what to do next: agents kept
 * setting a task_wait on the work they had just handed on, which the report already brings back.
 */
const REPORT_COMES_BACK =
  "The result comes back here as an automatic notice: once you have delegated what you planned, end your turn (no task_wait, no polling).";

/** Every place of the conversation is taken (see tasks/delegation-slots.ts): the task starts on its own. */
const QUEUED =
  "Too many of your delegated tasks are running; this one starts on its own when one of them finishes. Do not start it again.";

export const runTools: Record<string, ToolFactory> = {
  delegate_task: (ctx) =>
    tool({
      description: DELEGATE,
      inputSchema: z.object({
        agentSlug: z.string(),
        taskId: optionalId().describe("An existing task to start again or hand to another agent"),
        title: optionalText().describe("Required for a new task"),
        description: optionalText().describe("Required for a new task; for an existing one, add notes with task_comment"),
        projectId: optionalId(),
        priority: z.enum(TASK_PRIORITIES).default("medium"),
        deadline: optionalDateTime(),
        dependsOnTaskIds: z.array(z.string().uuid()).default([]),
        userAsked: z
          .boolean()
          .default(false)
          .describe("With taskId: true only when the user asked you in this conversation to retry or reassign the task"),
        files: z
          .preprocess(blankToUndefined, z.array(z.string().trim().min(1)).default([]))
          .describe(
            "Paths of files in your workspace the agent needs (e.g. inputs/1a2b3c4d/contract.pdf for a file the user attached, or one you made), at most 50 MB each. The agent finds them in its workspace's inputs. With taskId, a file named like one you handed over before replaces it.",
          ),
      }),
      execute: async (input, { abortSignal, experimental_sandbox: sandbox }) => {
        const agent = await agentBySlug(input.agentSlug);
        if (!agent || agent.isTemplate || !agent.enabled) {
          return { error: `Agent ${input.agentSlug} does not exist or is disabled. Use agent_list.` };
        }
        const [existing] = input.taskId ? await db.select().from(tasks).where(eq(tasks.id, input.taskId)) : [];
        if (input.taskId && !existing) return { error: `Task ${input.taskId} does not exist. Use task_list.` };
        // Handing on its own task would cut the report to whoever gave it; parts of it go as new tasks.
        if (existing?.assigneeAgentId === ctx.agent.id) {
          return { error: "This task is yours: delegate parts of it as new tasks and finish it yourself." };
        }
        // Who may hand what to whom: the super agent reaches a project through its manager, a manager its team.
        const delegator = {
          id: ctx.agent.id,
          kind: ctx.agent.kind,
          managedProjectIds: ctx.managedProjectIds,
        };
        const resolved = delegationProjectId(
          delegator,
          ctx.projectId,
          existing ? existing.projectId : (input.projectId ?? null),
        );
        if (!resolved.ok) return { error: resolved.error };
        if (existing && resolved.value !== existing.projectId) {
          return { error: `Task ${existing.id} is not in a project you can delegate in.` };
        }
        const project = resolved.value ? await loadDelegationProject(resolved.value) : null;
        if (resolved.value && !project) return { error: `Project ${resolved.value} does not exist. Use project_list.` };
        const allowed = checkDelegationTarget(delegator, agent, project);
        if (!allowed.ok) return { error: allowed.error };
        // Every file is read before anything changes, so a missing or oversized one delegates nothing.
        const handover = await readHandover(input.files, sandbox, abortSignal);
        if ("error" in handover) return handover;

        let taskId: string;
        let plan: { save: Handover[]; replace: string[] };
        if (existing) {
          const task = existing;
          const active = await activeTaskRun(task.id);
          if (active)
            return { error: `Task ${task.id} already has an active run (${active.id}). Use run_get or run_cancel.` };
          // Before anything changes; handing the task to another agent starts its count again.
          if (task.assigneeAgentId === agent.id) {
            const streak = await taskFailureStreak(task.id);
            if (streak.open) return circuitOpen(task.id, streak);
          }
          // A retry counts as the user's only in a turn that answers them, never in one answering a notice.
          const userAsked = input.userAsked && (await answersUser(ctx.run.conversationId));
          if (!userAsked && task.redelegations >= MAX_REDELEGATIONS) {
            return {
              error: `Task ${task.id} was already sent back ${task.redelegations} times. Ask the user how to proceed; if they ask for another attempt, call again with userAsked=true.`,
            };
          }
          const planned = planHandover(
            handover,
            await handedOverBefore(
              task.id,
              handover.map((f) => f.name),
            ),
          );
          if ("error" in planned) return planned;
          plan = planned;
          await redelegateTask(task.id, agent.id, ctx.run.id, { actor: actorOf(ctx), userAsked });
          taskId = task.id;
        } else {
          if (!input.title || input.title.trim().length < 3)
            return { error: "A new task needs a title (at least 3 characters)" };
          if (!input.description || input.description.trim().length < 10) {
            return { error: "A new task needs a complete description (at least 10 characters)" };
          }
          const planned = planHandover(handover, []);
          if ("error" in planned) return planned;
          plan = planned;
          const parentId = await ownTaskParent(ctx, resolved.value);
          let task: Task;
          try {
            task = await createTask(
              {
                title: input.title.trim(),
                description: input.description,
                projectId: resolved.value,
                parentId,
                priority: input.priority,
                deadline: input.deadline ? new Date(input.deadline) : null,
                assigneeAgentId: agent.id,
                dependsOn: input.dependsOnTaskIds,
                delegatedByRunId: ctx.run.id,
              },
              actorOf(ctx),
            );
          } catch (error) {
            if (isUserError(error)) return errorResult(error);
            throw error;
          }
          taskId = task.id;
        }
        await storeHandover(ctx, taskId, plan);
        const handedOver = handover.length ? { files: handover.map((f) => f.name) } : {};

        const open = await pendingDependencies(taskId);
        if (open.length) {
          // Backlog is what starts on its own once the dependencies are done.
          if (input.taskId) await updateTask(taskId, { status: "backlog" }, actorOf(ctx));
          return { taskId, started: false, waitingFor: open.map((o) => o.id), ...handedOver };
        }
        try {
          const run = await startDelegatedTask(taskId, { parentRunId: ctx.run.id });
          if (!run) return { taskId, started: false, queued: QUEUED, ...handedOver };
          return { taskId, runId: run.id, started: true, next: REPORT_COMES_BACK, ...handedOver };
        } catch (error) {
          // A parallel call started the same task first.
          if (isActiveTaskRunConflict(error)) {
            return { error: `Task ${taskId} already has an active run. Use run_get or run_cancel.` };
          }
          if (error instanceof TaskCircuitOpenError) return circuitOpen(taskId, error.streak);
          throw error;
        }
      },
    }),

  run_list: (ctx) =>
    tool({
      description: "Recent runs: status, agent, cost, errors. Use it for progress reports; run_get has a run's result.",
      inputSchema: z.object({
        sinceHours: z
          .number()
          .min(1)
          .max(24 * 30)
          .default(24),
        status: z.enum(RUN_STATUSES).optional(),
        agentSlug: optionalText(),
      }),
      execute: async ({ sinceHours, status, agentSlug }) => {
        const closed = await closedProjects(ctx);
        const rows = await db
          .select({
            id: runs.id,
            agent: agents.slug,
            status: runs.status,
            trigger: runs.trigger,
            projectId: runs.projectId,
            taskId: runs.taskId,
            costUsd: runs.costUsd,
            error: runs.error,
            createdAt: runs.createdAt,
          })
          .from(runs)
          .leftJoin(agents, eq(agents.id, runs.agentId))
          .where(
            and(
              gte(runs.createdAt, new Date(Date.now() - sinceHours * 3600_000)),
              status ? eq(runs.status, status) : undefined,
              agentSlug ? eq(agents.slug, agentSlug) : undefined,
            ),
          )
          .orderBy(desc(runs.createdAt))
          .limit(50);
        return rows.map((r) => withholdClosed(r, r.projectId, closed, ["error"]));
      },
    }),

  run_get: (ctx) =>
    tool({
      description:
        "Read one run: its result (output), error, cost, the task it worked on, the runs it started, pending approvals and its last steps.",
      inputSchema: z.object({ runId: z.string().uuid() }),
      execute: async ({ runId }) => {
        const [row] = await db
          .select({ run: runs, agent: agents.slug, task: tasks.title })
          .from(runs)
          .leftJoin(agents, eq(agents.id, runs.agentId))
          .leftJoin(tasks, eq(tasks.id, runs.taskId))
          .where(eq(runs.id, runId));
        if (!row) return { error: `Run ${runId} does not exist. Use run_list.` };
        const { run } = row;
        const [closed, children, pending, steps] = await Promise.all([
          runContentClosed(ctx, run),
          db
            .select({ id: runs.id, agent: agents.slug, status: runs.status, taskId: runs.taskId })
            .from(runs)
            .leftJoin(agents, eq(agents.id, runs.agentId))
            .where(eq(runs.parentRunId, run.id)),
          db
            .select({ tool: approvals.toolName, createdAt: approvals.createdAt })
            .from(approvals)
            .where(and(eq(approvals.runId, run.id), eq(approvals.status, "pending"))),
          db
            .select({ data: runEvents.data })
            .from(runEvents)
            .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, "step")))
            .orderBy(desc(runEvents.id))
            .limit(STEP_LIMIT),
        ]);
        const details = {
          id: run.id,
          agent: row.agent,
          status: run.status,
          trigger: run.trigger,
          task: run.taskId ? { id: run.taskId, title: row.task } : null,
          parentRunId: run.parentRunId,
          input: clip(run.input, 4_000),
          output: clip(run.output, 20_000),
          error: run.error,
          model: run.model ? `${run.provider}/${run.model}` : null,
          steps: run.steps,
          costUsd: run.costUsd,
          createdAt: run.createdAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
          childRuns: children,
          pendingApprovals: pending.map((p) => ({ tool: p.tool, since: p.createdAt.toISOString() })),
          // Oldest first; only the last few steps are kept.
          lastSteps: steps.reverse().map(({ data }) => {
            const step = data as StepEvent;
            return { step: step.step, tools: step.toolCalls?.map((c) => c.name) ?? [], text: clip(step.text || null, 500) };
          }),
        };
        return withhold(details, closed, ["input", "output", "error", "lastSteps"]);
      },
    }),

  run_cancel: (ctx) =>
    tool({
      description:
        "Stop a run that is queued, running or waiting for an approval (e.g. a delegated task that went off track). Say why.",
      inputSchema: z.object({ runId: z.string().uuid(), reason: z.string().min(3) }),
      execute: async ({ runId, reason }) => {
        if (runId === ctx.run.id) return { error: "This is your own run; finish your answer instead" };
        const run = await cancelRun(runId, `Stopped by ${ctx.agent.slug}: ${reason}`, "other");
        if (!run) return { error: `Run ${runId} does not exist or has already finished` };
        await audit({ actor: actorOf(ctx), action: "run.cancelled", entityType: "run", entityId: runId, data: { reason } });
        return { runId, stopped: run.status === "cancelled" ? "now" : "stopping" };
      },
    }),
};
