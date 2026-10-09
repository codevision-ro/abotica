import { agents, db, schedules, triggers } from "@abotica/db";
import { tool } from "ai";
import { eq } from "@abotica/db/orm";
import { z } from "zod";
import { audit } from "../../platform/audit";
import { isValidCron } from "../../automations/cron";
import { env } from "../../infra/env";
import { createSchedule, deleteSchedule, updateSchedule } from "../../automations/schedules";
import type { Delegator } from "../../tasks/team-rules";
import { TRIGGER_EVENT_VALUES, usesWebhook } from "../../automations/trigger-events";
import { deleteTrigger, saveTrigger } from "../../automations/triggers";
import type { RunContext } from "../context";
import {
  actorOf,
  agentBySlug,
  clip,
  errorResult,
  optionalDateTime,
  optionalId,
  optionalText,
  type ToolFactory,
} from "./shared";

type Timing = Pick<typeof schedules.$inferSelect, "kind" | "cron" | "runAt">;

/** The calling agent, held to the delegation rules for whom it may make runs of. */
const delegatorOf = (ctx: RunContext): Delegator => ({
  id: ctx.agent.id,
  kind: ctx.agent.kind,
  managedProjectIds: ctx.managedProjectIds,
});

/**
 * A webhook trigger's URL is a secret: agents never get it, so an injected instruction cannot send
 * it out. The user copies it from the Automations page.
 */
const webhookNotice = () =>
  `The secret URL is shown to the user on the Automations page (${new URL("/automations", env().APP_URL)}); point them there.`;

/** The agent that runs a schedule or trigger: the named one, or the caller. */
async function runnerAgent(ctx: RunContext, slug: string | undefined) {
  if (!slug) return ctx.agent;
  const agent = await agentBySlug(slug);
  if (!agent) throw new Error(`Agent ${slug} does not exist. Use agent_list.`);
  return agent;
}

export const automationTools: Record<string, ToolFactory> = {
  schedule_manage: (ctx) =>
    tool({
      description: `Manage schedules: list, create (cron or one-off), update (change fields, pause with enabled=false, resume) and delete. Cron uses the standard 5-field format, timezone ${ctx.settings.general.timezone}.`,
      inputSchema: z.object({
        action: z.enum(["list", "create", "update", "delete"]),
        scheduleId: optionalId().describe("For update and delete"),
        agentSlug: optionalText().describe("Who runs it; defaults to you"),
        name: optionalText(),
        cron: optionalText().describe("E.g. '0 9 * * 1-5' = weekdays at 9:00"),
        runAt: optionalDateTime().describe("For a one-off run"),
        prompt: optionalText().describe("What the agent should do on each run"),
        projectId: optionalId(),
        enabled: z.boolean().optional(),
      }),
      execute: async (input) => {
        if (input.action === "list") {
          const rows = await db
            .select({ schedule: schedules, agent: agents.slug })
            .from(schedules)
            .innerJoin(agents, eq(agents.id, schedules.agentId));
          return rows.map(({ schedule: s, agent }) => ({
            id: s.id,
            name: s.name,
            agent,
            kind: s.kind,
            cron: s.cron,
            runAt: s.runAt?.toISOString() ?? null,
            timezone: s.timezone,
            projectId: s.projectId,
            enabled: s.enabled,
            lastRunAt: s.lastRunAt?.toISOString() ?? null,
            prompt: clip(s.prompt, 300),
          }));
        }
        if (input.cron && !isValidCron(input.cron))
          return { error: `Invalid cron "${input.cron}": use 5 fields, e.g. '0 9 * * 1-5'` };
        if (input.cron && input.runAt) return { error: "Send either cron or runAt, not both" };
        if (input.runAt && new Date(input.runAt).getTime() <= Date.now()) return { error: "runAt must be in the future" };
        const timing: Timing | null = input.cron
          ? { kind: "cron", cron: input.cron, runAt: null }
          : input.runAt
            ? { kind: "once", cron: null, runAt: new Date(input.runAt) }
            : null;

        try {
          if (input.action === "delete" || input.action === "update") {
            if (!input.scheduleId) return { error: "scheduleId is missing" };
            const [current] = await db.select().from(schedules).where(eq(schedules.id, input.scheduleId));
            if (!current) return { error: `Schedule ${input.scheduleId} does not exist. Use list.` };
            if (input.action === "delete") {
              await deleteSchedule(current.id);
              await audit({
                actor: actorOf(ctx),
                action: "schedule.deleted",
                entityType: "schedule",
                entityId: current.id,
              });
              return { deleted: true };
            }
            const agent = input.agentSlug ? await runnerAgent(ctx, input.agentSlug) : undefined;
            const schedule = await updateSchedule(
              current.id,
              {
                ...timing,
                ...(agent && { agentId: agent.id }),
                ...(input.name && { name: input.name }),
                ...(input.prompt && { prompt: input.prompt }),
                ...(input.projectId && { projectId: input.projectId }),
                ...(input.enabled !== undefined && { enabled: input.enabled }),
              },
              { by: delegatorOf(ctx) },
            );
            await audit({ actor: actorOf(ctx), action: "schedule.updated", entityType: "schedule", entityId: schedule.id });
            return { id: schedule.id, enabled: schedule.enabled };
          }

          if (!input.prompt || !input.name || !timing) {
            return { error: "create needs name, prompt and either cron or runAt" };
          }
          const agent = await runnerAgent(ctx, input.agentSlug);
          const schedule = await createSchedule(
            {
              agentId: agent.id,
              projectId: input.projectId ?? null,
              name: input.name,
              ...timing,
              timezone: ctx.settings.general.timezone,
              prompt: input.prompt,
              enabled: input.enabled ?? true,
            },
            { by: delegatorOf(ctx) },
          );
          await audit({ actor: actorOf(ctx), action: "schedule.created", entityType: "schedule", entityId: schedule.id });
          return { id: schedule.id };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),

  trigger_manage: (ctx) =>
    tool({
      description: `Manage event triggers: list, create, update (change fields, pause with enabled=false) and delete. A trigger starts an agent run when its event happens: ${TRIGGER_EVENT_VALUES.join(", ")}. The prompt may contain {{payload}}, replaced with the event data. Webhook and email triggers get a secret URL that outside services POST to; only the user sees it, on the Automations page.`,
      inputSchema: z.object({
        action: z.enum(["list", "create", "update", "delete"]),
        triggerId: optionalId().describe("For update and delete"),
        event: z.enum(TRIGGER_EVENT_VALUES).optional(),
        agentSlug: optionalText().describe("Who runs it; defaults to you"),
        name: optionalText(),
        prompt: optionalText(),
        projectId: optionalId().describe("Task events: only tasks of this project"),
        enabled: z.boolean().optional(),
      }),
      execute: async (input) => {
        if (input.action === "list") {
          const rows = await db
            .select({ trigger: triggers, agent: agents.slug })
            .from(triggers)
            .innerJoin(agents, eq(agents.id, triggers.agentId));
          return rows.map(({ trigger: t, agent }) => ({
            id: t.id,
            name: t.name,
            event: t.event,
            agent,
            projectId: t.projectId,
            enabled: t.enabled,
            hasWebhookUrl: Boolean(t.token),
            prompt: clip(t.prompt, 300),
          }));
        }

        try {
          if (input.action === "delete") {
            if (!input.triggerId) return { error: "triggerId is missing" };
            await deleteTrigger(input.triggerId);
            await audit({
              actor: actorOf(ctx),
              action: "trigger.deleted",
              entityType: "trigger",
              entityId: input.triggerId,
            });
            return { deleted: true };
          }

          let current: typeof triggers.$inferSelect | undefined;
          if (input.action === "update") {
            if (!input.triggerId) return { error: "triggerId is missing" };
            [current] = await db.select().from(triggers).where(eq(triggers.id, input.triggerId));
            if (!current) return { error: `Trigger ${input.triggerId} does not exist. Use list.` };
          }
          const name = input.name ?? current?.name;
          const event = input.event ?? current?.event;
          const prompt = input.prompt ?? current?.prompt;
          if (!name || !event || !prompt) return { error: "create needs name, event and prompt" };
          const agent = input.agentSlug || !current ? await runnerAgent(ctx, input.agentSlug) : undefined;
          const trigger = await saveTrigger(
            {
              name,
              event,
              prompt,
              agentId: agent?.id ?? current!.agentId,
              projectId: input.projectId ?? current?.projectId ?? null,
              enabled: input.enabled ?? current?.enabled ?? true,
            },
            current?.id,
            { by: delegatorOf(ctx) },
          );
          await audit({
            actor: actorOf(ctx),
            action: current ? "trigger.updated" : "trigger.created",
            entityType: "trigger",
            entityId: trigger.id,
          });
          return {
            id: trigger.id,
            event: trigger.event,
            enabled: trigger.enabled,
            ...(usesWebhook(trigger.event) && { webhook: webhookNotice() }),
          };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
};
