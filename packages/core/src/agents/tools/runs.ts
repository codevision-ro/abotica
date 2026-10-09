import path from "node:path";
import { agents, approvals, db, files, projects, runEvents, runs, tasks } from "@abotica/db";
import { isUserError } from "@abotica/i18n";
import { type Experimental_SandboxSession, tool } from "ai";
import { and, desc, eq, gte, inArray, isNull, ne, or } from "@abotica/db/orm";
import { z } from "zod";
import { audit } from "../../platform/audit";
import { FILE_MAX_BYTES } from "../../platform/limits";
import { answersUser, loadDelegationProject, redelegateTask } from "../../tasks/delegation";
import { deleteFile, readFileBytes, saveFile } from "../../files/files";
import { cancelRun } from "../../runs/runs";
import { pauseTask } from "../../tasks/control";
import { startDelegatedTask } from "../../tasks/delegation-slots";
import {
  activeTaskRun,
  createTask,
  type FailureStreak,
  isActiveTaskRunConflict,
  pendingDependencies,
  type Task,
  TaskCircuitOpenError,
  type TaskPriority,
  taskFailureStreak,
  TASK_PRIORITIES,
  updateTask,
} from "../../tasks/tasks";
import { checkDelegationTarget, delegationProjectId } from "../../tasks/team-rules";
import type { RunContext } from "../context";
import { inControl } from "./control";
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
  visibleProjects,
} from "./shared";
import { withhold, withholdClosed } from "./withheld";
import { readWorkspaceBytes } from "./workspace";

const RUN_STATUSES = ["queued", "running", "waiting_approval", "succeeded", "failed", "cancelled"] as const;
const STEP_LIMIT = 8;

type StepEvent = { step?: number; text?: string; toolCalls?: { name: string }[] };

/** A file read from the workspace of the agent handing it over. */
export type Handover = { path: string; name: string; data: Uint8Array };

/**
 * Reads the files to hand over from the delegating agent's workspace; any problem fails them all.
 * delegate_task and ask_colleague (peers.ts) hand files to the task they create this way.
 */
export async function readHandover(
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
async function detailsBefore(taskId: string, names: string[]) {
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
export async function storeHandover(ctx: RunContext, taskId: string, plan: { save: Handover[]; replace: string[] }) {
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

/** The task the delegating run works on, if any. */
async function ownTask(ctx: RunContext): Promise<Pick<Task, "id" | "projectId" | "priority"> | null> {
  const id = ctx.run.taskId;
  if (!id) return null;
  const [own] = await db
    .select({ projectId: tasks.projectId, priority: tasks.priority })
    .from(tasks)
    .where(eq(tasks.id, id));
  return own ? { ...own, id } : null;
}

/**
 * A run working on a task of its own delegates parts of it: the new task is a subtask of that one, so the
 * work shows under it. Only within the same project, where a subtask belongs (see task_create).
 */
const ownTaskParent = (own: Pick<Task, "id" | "projectId"> | null, projectId: string | null): string | null =>
  own && own.projectId === projectId ? own.id : null;

const rank = (priority: TaskPriority) => TASK_PRIORITIES.indexOf(priority);

/** What the assignee works on besides the task delegated now. */
async function assigneeWork(agentId: string, exceptTaskId: string) {
  return db
    .select({
      taskId: tasks.id,
      title: tasks.title,
      priority: tasks.priority,
      projectId: tasks.projectId,
      project: projects.name,
      managerAgentId: projects.managerAgentId,
    })
    .from(tasks)
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.assigneeAgentId, agentId), eq(tasks.status, "in_progress"), ne(tasks.id, exceptTaskId)));
}

/** Said about work the delegator cannot put aside (another manager's project). */
const BUSY_ELSEWHERE = "It runs in parallel with this task; ask the super agent if the assignee's capacity matters.";

/**
 * Before urgent or high work starts: the assignee's other work underway (assigneeBusy), and with
 * `putAside` its work of lower priority that the delegator controls paused for the new task, to resume
 * on its own once that one settles. Lower-priority work it cannot control is listed as busyElsewhere.
 */
async function makeRoom(
  ctx: RunContext,
  task: { id: string; title: string; priority: TaskPriority },
  agentId: string,
  putAside: boolean,
) {
  if (!putAside && rank(task.priority) < rank("high")) return {};
  const parked: { taskId: string; title: string }[] = [];
  const elsewhere: { taskId: string; title: string; project: string | null }[] = [];
  const busy = [];
  for (const work of await assigneeWork(agentId, task.id)) {
    const controllable = inControl(ctx, work.projectId, work.managerAgentId);
    if (putAside && rank(work.priority) < rank(task.priority)) {
      if (!controllable) elsewhere.push({ taskId: work.taskId, title: work.title, project: work.project });
      else {
        try {
          await pauseTask(work.taskId, {
            by: { agentId: ctx.agent.id },
            reason: "it goes first",
            pausedForTaskId: task.id,
          });
          parked.push({ taskId: work.taskId, title: work.title });
          continue;
        } catch (error) {
          // Its run waits for an approval, or it settled meanwhile: it stays as it is.
          if (!isUserError(error)) throw error;
        }
      }
    }
    busy.push({ taskId: work.taskId, title: work.title, priority: work.priority, project: work.project, controllable });
  }
  return {
    ...(rank(task.priority) >= rank("high") && busy.length ? { assigneeBusy: busy } : {}),
    ...(parked.length ? { putAside: parked } : {}),
    ...(elsewhere.length ? { busyElsewhere: elsewhere, hint: BUSY_ELSEWHERE } : {}),
  };
}

/** The task's runs keep failing: the delegator reports it instead of trying again (see failureStreak). */
const circuitOpen = (taskId: string, streak: FailureStreak) => ({
  error: `Task ${taskId} is stopped: its last ${streak.failures} run(s) failed (${streak.reason ?? "no reason recorded"}). Starting it again would fail the same way. Tell the user what failed; only they can start it again, from the task page, once the cause is fixed.`,
});

/** The mechanics of delegating; whom to delegate to and what a brief holds is in the kind prompts. */
const DELEGATE =
  "Hand a task to an agent; it starts now, or once its dependencies are done or a place frees up (urgent work first). The agent sees neither your conversation nor your workspace: the description holds what it needs, files the files. To retry or reassign a task, send its taskId instead of a title and description. Priority defaults to your own task's. For urgent or high work the result lists the assignee's other work; putAside pauses its lower-priority work you control, which resumes on its own once this task settles. Its result comes back here as an automatic notice as soon as it settles: do not poll.";

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
        priority: z
          .preprocess(blankToUndefined, z.enum(TASK_PRIORITIES).optional())
          .describe("Left out: your own task's priority, or medium"),
        deadline: optionalDateTime(),
        dependsOnTaskIds: z.array(z.string().uuid()).default([]),
        putAside: z
          .boolean()
          .default(false)
          .describe("Pause the assignee's lower-priority work you control until this task settles"),
        reportTogether: optionalText().describe(
          "A key shared by tasks whose results make sense only together: they are reported in one notice once all settled",
        ),
        userAsked: z
          .boolean()
          .default(false)
          .describe("With taskId: true only when the user asked in this conversation for the retry"),
        files: z
          .preprocess(blankToUndefined, z.array(z.string().trim().min(1)).default([]))
          .describe(
            `Workspace paths of files the agent needs (e.g. inputs/1a2b3c4d/contract.pdf), at most ${FILE_MAX_BYTES / (1024 * 1024)} MB each; it finds them in its inputs. With taskId, a file of the same name replaces the one handed over before.`,
          ),
      }),
      execute: async (given, { abortSignal, experimental_sandbox: sandbox }) => {
        const agent = await agentBySlug(given.agentSlug);
        if (!agent || agent.isTemplate || !agent.enabled) {
          return { error: `Agent ${given.agentSlug} does not exist or is disabled. Use agent_list.` };
        }
        const [found] = given.taskId ? await db.select().from(tasks).where(eq(tasks.id, given.taskId)) : [];
        if (given.taskId && !found) return { error: `Task ${given.taskId} does not exist. Use task_list.` };
        // Its own task handed on would cut the report to whoever gave it: it goes out as a new task under it,
        // with the brief sent (or the task's own), and the delegator still finishes its task with the result.
        const handsOnOwn = found?.assigneeAgentId === ctx.agent.id;
        const existing = handsOnOwn ? undefined : found;
        const input = handsOnOwn
          ? {
              ...given,
              taskId: undefined,
              title: given.title ?? found.title,
              description: given.description ?? found.description,
              projectId: given.projectId ?? found.projectId ?? undefined,
            }
          : given;
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
        const own = await ownTask(ctx);
        let delegated: { id: string; title: string; priority: TaskPriority };
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
          if (!userAsked && task.redelegations >= ctx.settings.agents.maxRedelegations) {
            return {
              error: `Task ${task.id} was already sent back ${task.redelegations} times. Ask the user how to proceed; if they ask for another attempt, call again with userAsked=true.`,
            };
          }
          const planned = planHandover(
            handover,
            await detailsBefore(
              task.id,
              handover.map((f) => f.name),
            ),
          );
          if ("error" in planned) return planned;
          plan = planned;
          await redelegateTask(task.id, agent.id, ctx.run.id, { actor: actorOf(ctx), userAsked });
          if (input.priority && input.priority !== task.priority) {
            await updateTask(task.id, { priority: input.priority }, actorOf(ctx));
          }
          taskId = task.id;
          delegated = { id: task.id, title: task.title, priority: input.priority ?? task.priority };
        } else {
          if (!input.title || input.title.trim().length < 3)
            return { error: "A new task needs a title (at least 3 characters)" };
          if (!input.description || input.description.trim().length < 10) {
            return { error: "A new task needs a complete description (at least 10 characters)" };
          }
          const planned = planHandover(handover, []);
          if ("error" in planned) return planned;
          plan = planned;
          const parentId = ownTaskParent(own, resolved.value);
          let task: Task;
          try {
            task = await createTask(
              {
                title: input.title.trim(),
                description: input.description,
                projectId: resolved.value,
                parentId,
                priority: input.priority ?? own?.priority ?? "medium",
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
          delegated = task;
        }
        await storeHandover(ctx, taskId, plan);
        if (input.reportTogether) {
          await db.update(tasks).set({ reportGroup: input.reportTogether }).where(eq(tasks.id, taskId));
        }
        const details = {
          ...(handover.length ? { files: handover.map((f) => f.name) } : {}),
          ...(await makeRoom(ctx, delegated, agent.id, input.putAside)),
        };

        const open = await pendingDependencies(taskId);
        if (open.length) {
          // Backlog is what starts on its own once the dependencies are done.
          if (input.taskId) await updateTask(taskId, { status: "backlog" }, actorOf(ctx));
          return { taskId, started: false, waitingFor: open.map((o) => o.id), ...details };
        }
        try {
          const run = await startDelegatedTask(taskId, { parentRunId: ctx.run.id });
          if (!run) return { taskId, started: false, queued: QUEUED, ...details };
          return { taskId, runId: run.id, started: true, next: REPORT_COMES_BACK, ...details };
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
      description:
        "Recent runs (a manager: of the projects it leads): status, agent, cost, errors. Use it for progress reports; run_get has a run's result.",
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
        // The super agent sees every run, a manager the runs of the projects it leads.
        const visible = visibleProjects(ctx);
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
              visible ? inArray(runs.projectId, visible) : undefined,
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
        const visible = visibleProjects(ctx);
        const inScope = !visible || (row?.run.projectId != null && visible.includes(row.run.projectId));
        if (!row || !inScope) return { error: `Run ${runId} does not exist or is not visible to you. Use run_list.` };
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
