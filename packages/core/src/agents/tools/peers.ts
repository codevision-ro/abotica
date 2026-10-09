/**
 * Work across the team: a specialist asking a colleague for help, a manager adding a specialist to its
 * team, the super agent doing a small step inside a project itself. Each is a task like any delegated
 * one, so slots, reports and the chain of command apply to it unchanged.
 */
import { db, projects, tasks } from "@abotica/db";
import { getTranslator } from "@abotica/i18n";
import { tool } from "ai";
import { and, count, eq, isNull } from "@abotica/db/orm";
import { z } from "zod";
import { FILE_MAX_BYTES } from "../../platform/limits";
import { addProjectMembers } from "../../projects/projects";
import { deliverToSuperior } from "../../runs/deliver";
import { settingsLocale } from "../../settings/settings";
import { loadDelegationProject } from "../../tasks/delegation";
import { startDelegatedTask } from "../../tasks/delegation-slots";
import { createTask, type Task } from "../../tasks/tasks";
import { canJoinTeam, mayAskColleague } from "../../tasks/team-rules";
import { newMarkerId } from "../untrusted-id";
import { wrapUntrusted } from "../untrusted";
import { planHandover } from "./delegate-files";
import { readHandover, storeHandover } from "./runs";
import { actorOf, agentBySlug, blankToUndefined, closedProjects, optionalId, type ToolFactory } from "./shared";
import { WITHHELD_NOTE } from "./withheld";

/** Characters of the question in the help task's title. */
const HELP_TITLE_CHARS = 60;

/** Said with a started help task or step: the result arrives as a notice, nobody needs to poll. */
const ANSWER_COMES_BACK =
  "Go on with what does not depend on the answer. It comes back here as a notice between your steps; when nothing is left to do, end your turn: the answer wakes you.";

const RESULT_COMES_BACK =
  "The result comes back here as an automatic notice once the step is done: end your turn or go on with the rest (no task_wait, no polling).";

/** Help tasks a task asked for and has not had answered yet (see MAX_OPEN_HELP_TASKS). */
async function openHelpTasks(taskId: string): Promise<number> {
  const [row] = await db
    .select({ open: count() })
    .from(tasks)
    .where(and(eq(tasks.parentId, taskId), eq(tasks.kind, "help"), isNull(tasks.reportedAt)));
  return row?.open ?? 0;
}

async function ownTask(taskId: string | null): Promise<Task | null> {
  if (!taskId) return null;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return task ?? null;
}

/** "Help: " and the start of the question, cut at a word when it is long. */
export function helpTitle(prefix: (question: string) => string, question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  if (flat.length <= HELP_TITLE_CHARS) return prefix(flat);
  const cut = flat.slice(0, HELP_TITLE_CHARS);
  const space = cut.lastIndexOf(" ");
  return prefix(`${(space > HELP_TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}...`);
}

export const peerTools: Record<string, ToolFactory> = {
  ask_colleague: (ctx) =>
    tool({
      description:
        "Ask another specialist on your team for what they know or have. They answer as a small task of their own; the answer comes back here as a notice. Go on with what does not depend on it meanwhile.",
      inputSchema: z.object({
        agentSlug: z.string(),
        question: z.string().trim().min(1),
        files: z
          .preprocess(blankToUndefined, z.array(z.string().trim().min(1)).default([]))
          .describe(`Workspace paths of files they need to answer, at most ${FILE_MAX_BYTES / (1024 * 1024)} MB each`),
      }),
      execute: async ({ agentSlug, question, files }, { abortSignal, experimental_sandbox: sandbox }) => {
        const askerTask = await ownTask(ctx.run.taskId);
        const project = askerTask?.projectId ? await loadDelegationProject(askerTask.projectId) : null;
        const target = await agentBySlug(agentSlug);
        if (!target) return { error: `Agent ${agentSlug} does not exist. Your team is listed in your instructions.` };
        const allowed = mayAskColleague(
          ctx.agent,
          target,
          project,
          askerTask && {
            kind: askerTask.kind,
            projectId: askerTask.projectId,
            openHelpTasks: await openHelpTasks(askerTask.id),
          },
        );
        if (!allowed.ok) return { error: allowed.error };
        // mayAskColleague refuses without both; narrowed here for the types.
        if (!askerTask || !project) return { error: "You can ask a colleague only while working on a task in a project." };
        // Every file is read before anything changes, so a missing or oversized one asks nothing.
        const handover = await readHandover(files, sandbox, abortSignal);
        if ("error" in handover) return handover;
        const plan = planHandover(handover, []);
        if ("error" in plan) return plan;

        const t = getTranslator(settingsLocale(ctx.settings));
        const help = await createTask(
          {
            title: helpTitle((text) => t("team.help.taskTitle", { question: text }), question),
            description: [
              question,
              "",
              `${ctx.agent.name} (${ctx.agent.slug}) on ${project.name} asks for your help with their task "${askerTask.title}". Answer briefly and only what is asked: your output goes straight back to them.`,
            ].join("\n"),
            projectId: project.id,
            parentId: askerTask.id,
            priority: askerTask.priority,
            assigneeAgentId: target.id,
            delegatedByRunId: ctx.run.id,
            kind: "help",
          },
          actorOf(ctx),
        );
        await storeHandover(ctx, help.id, plan);
        const run = await startDelegatedTask(help.id, { parentRunId: ctx.run.id, reason: "help" });
        // For the manager's picture of the team, read at its next run: it does not wake it.
        // The notice's header names the asker and its task; the question is the asker's text, so data.
        const fyi = `Asked ${target.name} (${target.slug}) for help, as help task ${help.id}. The question:\n${wrapUntrusted(question, { source: "delegated-task", id: newMarkerId() })}`;
        // The help is underway either way: a failed notice must not read as a failed request, asked again.
        await deliverToSuperior(
          askerTask.id,
          { kind: "progress", text: fyi, from: ctx.agent.name },
          { wake: "never" },
        ).catch((error: unknown) =>
          console.warn(`[ask_colleague] notice to the superior of task ${askerTask.id} failed`, error),
        );
        return {
          taskId: help.id,
          colleague: target.slug,
          started: run !== null,
          ...(handover.length > 0 && { files: handover.map((f) => f.name) }),
          next: ANSWER_COMES_BACK,
        };
      },
    }),

  team_add: (ctx) =>
    tool({
      description:
        "Add an existing specialist (agent_list) to the team of a project you lead, so you can delegate to them.",
      inputSchema: z.object({
        agentSlug: z.string(),
        projectId: optionalId().describe("Leave out for the project of this run"),
      }),
      execute: async ({ agentSlug, projectId: requested }) => {
        // As with delegating: inside a project a manager changes that project's team only.
        const projectId = requested ?? ctx.projectId;
        if (!projectId) {
          return {
            error: ctx.managedProjectIds.length
              ? `Say which project: projectId of a project you lead (${ctx.managedProjectIds.join(", ")}).`
              : "You lead no project, so you have no team to add to.",
          };
        }
        if (ctx.projectId && projectId !== ctx.projectId) {
          return { error: "You can change only the team of the project of this run." };
        }
        if (!ctx.managedProjectIds.includes(projectId)) return { error: `You do not lead project ${projectId}.` };
        const agent = await agentBySlug(agentSlug);
        if (!agent || agent.isTemplate) return { error: `Agent ${agentSlug} does not exist. Use agent_list.` };
        if (!canJoinTeam(agent)) {
          return {
            error: agent.enabled
              ? `${agent.slug} is not a specialist: only specialists join a team.`
              : `${agent.slug} is disabled. Only the user can enable it; escalate if the team needs it.`,
          };
        }
        const added = await addProjectMembers(projectId, [agent.id], { actor: actorOf(ctx) });
        return {
          agentSlug: agent.slug,
          projectId,
          ...(added.length ? { added: true } : { added: false, note: `${agent.slug} was already on the team.` }),
          next: "You can delegate to it now.",
        };
      },
    }),

  work_in_project: (ctx) =>
    tool({
      description:
        "Do a small step inside a project yourself (a lookup, a one-line change), with the project's workspace, repositories and team memory. It runs as a task of yours in the project; the result comes back here as a notice.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        title: z.string().trim().min(1),
        brief: z.string().trim().min(1).describe("What to do, complete: the run does not see this conversation"),
      }),
      execute: async ({ projectId, title, brief }) => {
        if (ctx.project) {
          return { error: `You are already working inside ${ctx.project.name}: do this step in this run.` };
        }
        const [project] = await db
          .select({ id: projects.id, name: projects.name, status: projects.status })
          .from(projects)
          .where(eq(projects.id, projectId));
        if (!project) return { error: `Project ${projectId} does not exist. Use project_list.` };
        if (project.status === "archived") return { error: `Project ${project.name} is archived.` };
        // Its content would come back here, to models the project does not allow.
        if ((await closedProjects(ctx)).has(project.id)) return { error: `Project ${project.name}: ${WITHHELD_NOTE}` };
        const task = await createTask(
          {
            title,
            description: brief,
            projectId: project.id,
            assigneeAgentId: ctx.agent.id,
            delegatedByRunId: ctx.run.id,
          },
          actorOf(ctx),
        );
        const run = await startDelegatedTask(task.id, { parentRunId: ctx.run.id });
        return {
          taskId: task.id,
          ...(run ? { runId: run.id, started: true } : { started: false }),
          next: RESULT_COMES_BACK,
        };
      },
    }),
};
