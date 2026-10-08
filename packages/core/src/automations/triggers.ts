import { randomBytes } from "node:crypto";
import { agents, db, tasks, triggers } from "@abotica/db";
import { and, eq } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { audit } from "../platform/audit";
import { loadDelegationProject } from "../tasks/delegation";
import { env } from "../infra/env";
import { type Run, startRun } from "../runs/runs";
import { startDelegatedTask } from "../tasks/delegation-slots";
import { TaskCircuitOpenError, unblockedDependents } from "../tasks/tasks";
import { checkAutomationTarget, type Delegator, worksIn } from "../tasks/team-rules";
import { usesWebhook } from "./trigger-events";
import { encrypt } from "../platform/vault";
import { newSigningSecret } from "./webhook-signature";
import { newMarkerId } from "../agents/untrusted-id";
import { type UntrustedSource, wrapUntrusted } from "../agents/untrusted";

export type Trigger = typeof triggers.$inferSelect;
type TriggerValues = Pick<typeof triggers.$inferInsert, "name" | "agentId" | "projectId" | "event" | "prompt" | "enabled">;

const newToken = () => randomBytes(24).toString("base64url");

/** Public URL that fires a webhook trigger. */
export const webhookUrl = (token: string) => new URL(`/api/webhooks/${token}`, env().APP_URL).toString();

/**
 * Schedules and triggers start runs, so their agent must exist and not be a template. When an agent
 * sets one up (`by`), the delegation rules apply too: it may make runs only of whom it could give work.
 */
export async function assertAutomationAgent(agentId: string, projectId: string | null, by?: Delegator): Promise<void> {
  const [agent] = await db
    .select({ id: agents.id, slug: agents.slug, isTemplate: agents.isTemplate, isOrchestrator: agents.isOrchestrator })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent) throw new UserError("automations.errors.agentNotFound");
  if (agent.isTemplate) throw new UserError("automations.errors.templateCannotRun");
  if (!by) return;
  const project = projectId ? await loadDelegationProject(projectId) : null;
  if (projectId && !project) throw new Error(`Project ${projectId} does not exist. Use project_list.`);
  const allowed = checkAutomationTarget(by, agent, project);
  if (!allowed.ok) throw new Error(allowed.error);
}

/**
 * Creates a trigger, or updates one when `id` is set; webhook events keep their token and signing
 * secret across edits, other events drop both. `by`: the agent saving it (see assertAutomationAgent).
 */
export async function saveTrigger(values: TriggerValues, id?: string, opts: { by?: Delegator } = {}): Promise<Trigger> {
  const row = { ...values, projectId: values.projectId ?? null };
  if (!id) {
    await assertAutomationAgent(row.agentId, row.projectId, opts.by);
    const [created] = await db
      .insert(triggers)
      .values({ ...row, token: usesWebhook(values.event) ? newToken() : null })
      .returning();
    return created!;
  }
  const [current] = await db.select().from(triggers).where(eq(triggers.id, id));
  if (!current) throw new UserError("automations.errors.triggerNotFound");
  // Pausing or rewording keeps who runs where, so it needs no new check (an agent may pause what it did not set up).
  if (row.agentId !== current.agentId || row.projectId !== current.projectId) {
    await assertAutomationAgent(row.agentId, row.projectId, opts.by);
  }
  const webhook = usesWebhook(values.event);
  const [updated] = await db
    .update(triggers)
    .set({
      ...row,
      token: webhook ? (current.token ?? newToken()) : null,
      signingSecret: webhook ? current.signingSecret : null,
    })
    .where(eq(triggers.id, id))
    .returning();
  return updated!;
}

export async function setTriggerEnabled(id: string, enabled: boolean): Promise<Trigger> {
  const [row] = await db.update(triggers).set({ enabled }).where(eq(triggers.id, id)).returning();
  if (!row) throw new UserError("automations.errors.triggerNotFound");
  return row;
}

export async function deleteTrigger(id: string): Promise<void> {
  const [row] = await db.delete(triggers).where(eq(triggers.id, id)).returning({ id: triggers.id });
  if (!row) throw new UserError("automations.errors.triggerNotFound");
}

/** The webhook settings of trigger `id`; throws when it is missing or fires on another event. */
async function webhookTrigger(id: string) {
  const [current] = await db
    .select({ event: triggers.event, signingSecret: triggers.signingSecret })
    .from(triggers)
    .where(eq(triggers.id, id));
  if (!current) throw new UserError("automations.errors.triggerNotFound");
  if (!usesWebhook(current.event)) throw new UserError("automations.errors.triggerNotWebhook");
  return current;
}

/** A new secret URL for a webhook trigger; the old one stops working. */
export async function regenerateTriggerToken(id: string): Promise<string> {
  await webhookTrigger(id);
  const token = newToken();
  await db.update(triggers).set({ token }).where(eq(triggers.id, id));
  return token;
}

/**
 * A new secret that the trigger's webhook requests must be signed with; it replaces the current
 * one, which stops working at once. Returned this once: only its encrypted form is stored.
 */
export async function createTriggerSigningSecret(id: string, opts: { actor?: string } = {}): Promise<string> {
  const current = await webhookTrigger(id);
  const secret = newSigningSecret();
  await db
    .update(triggers)
    .set({ signingSecret: encrypt(secret) })
    .where(eq(triggers.id, id));
  await audit({
    actor: opts.actor ?? "user",
    action: current.signingSecret ? "trigger.signing-secret-rotated" : "trigger.signing-secret-created",
    entityType: "trigger",
    entityId: id,
  });
  return secret;
}

/** The trigger accepts unsigned webhook requests again. */
export async function deleteTriggerSigningSecret(id: string, opts: { actor?: string } = {}): Promise<void> {
  const current = await webhookTrigger(id);
  if (!current.signingSecret) return;
  await db.update(triggers).set({ signingSecret: null }).where(eq(triggers.id, id));
  await audit({
    actor: opts.actor ?? "user",
    action: "trigger.signing-secret-deleted",
    entityType: "trigger",
    entityId: id,
  });
}

/**
 * The run input for a trigger: `{{payload}}` in the prompt is replaced by the payload, or the
 * payload is appended when the prompt has no placeholder. The payload goes in as untrusted data
 * (`source`), while the prompt the user wrote stays outside the block. A function replacement keeps
 * `$&` and similar sequences in the payload literal.
 */
export function renderTriggerInput(prompt: string, payload: string, source: UntrustedSource): string {
  const block = wrapUntrusted(payload, { source, id: newMarkerId() });
  return prompt.includes("{{payload}}") ? prompt.replaceAll("{{payload}}", () => block) : `${prompt}\n\nPayload:\n${block}`;
}

/**
 * Starts the run for a fired trigger. `projectId` defaults to the trigger's project; `subject`
 * (e.g. the task title) is added to the run title after the trigger name.
 */
export async function fireTrigger(
  trigger: Trigger,
  payload: string,
  opts: { projectId?: string | null; subject?: string } = {},
): Promise<Run> {
  const projectId = opts.projectId === undefined ? trigger.projectId : opts.projectId;
  await assertWorksIn(trigger.agentId, projectId);
  const webhook = usesWebhook(trigger.event);
  return startRun({
    agentId: trigger.agentId,
    trigger: webhook ? "webhook" : "event",
    // Task events carry the task's output, which its agent wrote and may quote pages or files in.
    input: renderTriggerInput(trigger.prompt, payload, webhook ? "webhook" : "task-output"),
    projectId,
    title: opts.subject ? `${trigger.name}: ${opts.subject}` : trigger.name,
  });
}

/** Raised when an automation's agent may not work in the project its run would work in. */
export class AgentNotOnTeamError extends UserError {
  constructor() {
    super("automations.errors.agentNotOnTeam");
  }
}

/**
 * Checked each time an automation fires, not only when it is saved: a run in a project gets its memory,
 * servers and repositories, so only an agent on that team may, as with delegated work. That covers a
 * trigger without a project firing for a project's task, and an agent removed from the team later.
 */
export async function assertWorksIn(agentId: string, projectId: string | null): Promise<void> {
  if (!projectId) return;
  const [[agent], project] = await Promise.all([
    db.select({ id: agents.id, isOrchestrator: agents.isOrchestrator }).from(agents).where(eq(agents.id, agentId)),
    loadDelegationProject(projectId),
  ]);
  if (!agent || !project || !worksIn(agent, project)) throw new AgentNotOnTeamError();
}

/** Fires task.created / task.done triggers and starts tasks whose dependencies just finished. */
export async function handleTaskEvent(taskId: string, event: "created" | "done"): Promise<void> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return; // deleted since the event was queued
  const name = event === "created" ? "task.created" : "task.done";
  const rows = await db
    .select()
    .from(triggers)
    .where(and(eq(triggers.event, name), eq(triggers.enabled, true)));
  // The job runs once (a retry would fire the others again), so one failure must not stop the rest.
  for (const trigger of rows) {
    if (trigger.projectId && trigger.projectId !== task.projectId) continue;
    const payload = JSON.stringify({ id: task.id, title: task.title, status: task.status, output: task.output }, null, 2);
    try {
      await fireTrigger(trigger, payload, { projectId: task.projectId, subject: task.title });
    } catch (error) {
      if (error instanceof AgentNotOnTeamError) {
        console.warn(`[triggers] trigger ${trigger.id} skipped task ${task.id}: its agent is not on the project's team`);
      } else {
        console.error(`[triggers] trigger ${trigger.id} on task ${task.id} failed:`, error);
      }
    }
  }

  if (event === "done") {
    for (const next of await unblockedDependents(task.id)) {
      if (!next.assigneeAgentId || next.status !== "backlog") continue;
      try {
        // A delegated one takes a place of its delegator's conversation, or waits for one.
        await startDelegatedTask(next.id);
      } catch (error) {
        if (error instanceof TaskCircuitOpenError) {
          console.warn(`[triggers] task ${next.id} not started after ${task.id}: its runs keep failing`);
        } else {
          console.error(`[triggers] starting task ${next.id} after ${task.id} failed:`, error);
        }
      }
    }
  }
}
