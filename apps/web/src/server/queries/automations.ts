import "server-only";
import { getSettings, type Trigger, WEBHOOK_EVENTS } from "@abotica/core";
import { agents, db, projects, schedules, triggers } from "@abotica/db";
import { and, asc, desc, eq, inArray, sql } from "@abotica/db/orm";
import { getLocale } from "next-intl/server";
import { publicQuery, query } from "@/server/query";

export const getAutomationOptions = query(async () => {
  const [agentRows, projectRows, settings] = await Promise.all([
    db
      .select({ id: agents.id, name: agents.name, avatar: agents.avatar })
      .from(agents)
      .where(and(eq(agents.isTemplate, false), eq(agents.enabled, true)))
      .orderBy(desc(agents.isOrchestrator), asc(agents.name)),
    db.select({ id: projects.id, name: projects.name }).from(projects).orderBy(asc(projects.name)),
    getSettings(),
  ]);
  return { agents: agentRows, projects: projectRows, timezone: settings.timezone };
});

/** Natural order in the current language, so "schedule 2" comes before "schedule 10". */
async function byName() {
  const collator = new Intl.Collator(await getLocale(), { numeric: true, sensitivity: "base" });
  return (a: { name: string }, b: { name: string }) => collator.compare(a.name, b.name);
}

export const listSchedules = query(async () => {
  const compare = await byName();
  return db
    .select({
      id: schedules.id,
      name: schedules.name,
      kind: schedules.kind,
      cron: schedules.cron,
      runAt: schedules.runAt,
      timezone: schedules.timezone,
      prompt: schedules.prompt,
      enabled: schedules.enabled,
      lastRunAt: schedules.lastRunAt,
      agentId: schedules.agentId,
      projectId: schedules.projectId,
      agentName: agents.name,
      agentAvatar: agents.avatar,
      projectName: projects.name,
    })
    .from(schedules)
    .innerJoin(agents, eq(agents.id, schedules.agentId))
    .leftJoin(projects, eq(projects.id, schedules.projectId))
    .then((rows) => rows.sort(compare));
});

export const listTriggers = query(async () => {
  const compare = await byName();
  return db
    .select({
      id: triggers.id,
      name: triggers.name,
      event: triggers.event,
      token: triggers.token,
      /** Whether webhook requests must be signed; the secret itself never leaves the server. */
      signed: sql<boolean>`${triggers.signingSecret} is not null`,
      prompt: triggers.prompt,
      enabled: triggers.enabled,
      agentId: triggers.agentId,
      projectId: triggers.projectId,
      agentName: agents.name,
      agentAvatar: agents.avatar,
      projectName: projects.name,
    })
    .from(triggers)
    .innerJoin(agents, eq(agents.id, triggers.agentId))
    .leftJoin(projects, eq(projects.id, triggers.projectId))
    .then((rows) => rows.sort(compare));
});

/**
 * The enabled trigger a webhook URL points to, or null for an unknown token. A query without a session
 * check: the public webhook route calls it, and the secret token is the credential.
 */
export const getWebhookTrigger = publicQuery(async (token: string): Promise<Trigger | null> => {
  const [trigger] = await db
    .select()
    .from(triggers)
    .where(and(eq(triggers.token, token), eq(triggers.enabled, true), inArray(triggers.event, WEBHOOK_EVENTS)));
  return trigger ?? null;
});
