"use server";

import {
  audit,
  createSchedule as createScheduleRow,
  createTriggerSigningSecret as createSigningSecret,
  deleteSchedule as deleteScheduleRow,
  deleteTrigger as deleteTriggerRow,
  deleteTriggerSigningSecret as deleteSigningSecret,
  regenerateTriggerToken as rotateTriggerToken,
  saveTrigger as saveTriggerRow,
  runScheduleNow,
  setTriggerEnabled as setTriggerRowEnabled,
  updateSchedule as updateScheduleRow,
} from "@abotica/core";
import { isValidCron } from "@abotica/core/cron";
import { TRIGGER_EVENT_VALUES } from "@abotica/core/trigger-events";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isTimeZone, zonedLocalToDate } from "@/lib/time-zone";
import { action } from "../action";

const scheduleFields = z.object({
  name: z.string().trim().min(1, "automations.validation.nameRequired").max(120),
  agentId: z.string().uuid("automations.validation.chooseAgent"),
  projectId: z.string().uuid().nullish(),
  kind: z.enum(["cron", "once"]),
  cron: z.string().trim().nullish(),
  /** Wall time in `timezone`, as produced by <input type="datetime-local">. */
  runAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "automations.validation.invalidDate")
    .nullish(),
  timezone: z.string().trim().min(1).refine(isTimeZone, "automations.validation.invalidTimezone"),
  prompt: z.string().trim().min(1, "automations.validation.promptRequired").max(20_000),
  enabled: z.boolean().default(true),
});

type ScheduleInput = z.output<typeof scheduleFields>;

// Applied after `extend`, since zod refuses to extend an object that already has refinements.
function checkSchedule(v: ScheduleInput, ctx: z.RefinementCtx) {
  if (v.kind === "cron" && !(v.cron && isValidCron(v.cron))) {
    ctx.addIssue({ code: "custom", message: "automations.validation.invalidCron", path: ["cron"] });
  }
  if (v.kind === "once" && !v.runAt) {
    ctx.addIssue({ code: "custom", message: "automations.validation.chooseDateTime", path: ["runAt"] });
  }
}

async function writeSchedule(id: string | undefined, input: ScheduleInput) {
  // Core checks the agent and the timing, and normalizes the cron.
  const values = {
    name: input.name,
    agentId: input.agentId,
    projectId: input.projectId ?? null,
    kind: input.kind,
    cron: input.kind === "cron" ? input.cron : null,
    runAt: input.kind === "once" ? zonedLocalToDate(input.runAt!, input.timezone) : null,
    timezone: input.timezone,
    prompt: input.prompt,
    enabled: input.enabled,
  };
  const row = id ? await updateScheduleRow(id, values) : await createScheduleRow(values);
  await audit({
    actor: "user",
    action: id ? "schedule.updated" : "schedule.created",
    entityType: "schedule",
    entityId: row.id,
  });
  revalidatePath("/automations");
  return { id: row.id };
}

export const createSchedule = action(scheduleFields.superRefine(checkSchedule), (input) => writeSchedule(undefined, input));

export const updateSchedule = action(
  scheduleFields.extend({ id: z.string().uuid() }).superRefine(checkSchedule),
  ({ id, ...input }) => writeSchedule(id, input),
);

export const setScheduleEnabled = action(
  z.object({ id: z.string().uuid(), enabled: z.boolean() }),
  async ({ id, enabled }) => {
    await updateScheduleRow(id, { enabled });
    await audit({
      actor: "user",
      action: enabled ? "schedule.enabled" : "schedule.disabled",
      entityType: "schedule",
      entityId: id,
    });
    revalidatePath("/automations");
  },
);

export const deleteSchedule = action(z.object({ id: z.string().uuid() }), async ({ id }) => {
  await deleteScheduleRow(id);
  await audit({ actor: "user", action: "schedule.deleted", entityType: "schedule", entityId: id });
  revalidatePath("/automations");
});

export const startScheduleRun = action(z.object({ id: z.string().uuid() }), async ({ id }) => {
  const run = await runScheduleNow(id);
  await audit({
    actor: "user",
    action: "schedule.run-started",
    entityType: "schedule",
    entityId: id,
    data: { runId: run.id },
  });
  revalidatePath("/automations");
  return { runId: run.id };
});

const triggerInput = z.object({
  name: z.string().trim().min(1, "automations.validation.nameRequired").max(120),
  agentId: z.string().uuid("automations.validation.chooseAgent"),
  projectId: z.string().uuid().nullish(),
  event: z.enum(TRIGGER_EVENT_VALUES),
  prompt: z.string().trim().min(1, "automations.validation.promptRequired").max(20_000),
  enabled: z.boolean().default(true),
});

async function writeTrigger(id: string | undefined, input: z.output<typeof triggerInput>) {
  const row = await saveTriggerRow(input, id);
  await audit({
    actor: "user",
    action: id ? "trigger.updated" : "trigger.created",
    entityType: "trigger",
    entityId: row.id,
  });
  revalidatePath("/automations");
  return { id: row.id, token: row.token };
}

export const createTrigger = action(triggerInput, (input) => writeTrigger(undefined, input));

export const updateTrigger = action(triggerInput.extend({ id: z.string().uuid() }), ({ id, ...input }) =>
  writeTrigger(id, input),
);

export const setTriggerEnabled = action(
  z.object({ id: z.string().uuid(), enabled: z.boolean() }),
  async ({ id, enabled }) => {
    await setTriggerRowEnabled(id, enabled);
    await audit({
      actor: "user",
      action: enabled ? "trigger.enabled" : "trigger.disabled",
      entityType: "trigger",
      entityId: id,
    });
    revalidatePath("/automations");
  },
);

export const deleteTrigger = action(z.object({ id: z.string().uuid() }), async ({ id }) => {
  await deleteTriggerRow(id);
  await audit({ actor: "user", action: "trigger.deleted", entityType: "trigger", entityId: id });
  revalidatePath("/automations");
});

export const regenerateTriggerToken = action(z.object({ id: z.string().uuid() }), async ({ id }) => {
  const token = await rotateTriggerToken(id);
  await audit({ actor: "user", action: "trigger.token-regenerated", entityType: "trigger", entityId: id });
  revalidatePath("/automations");
  return { token };
});

/** A new signing secret for a webhook trigger, replacing the current one; shown to the user once. */
export const createTriggerSigningSecret = action(z.object({ id: z.string().uuid() }), async ({ id }) => {
  const secret = await createSigningSecret(id);
  revalidatePath("/automations");
  return { secret };
});

export const deleteTriggerSigningSecret = action(z.object({ id: z.string().uuid() }), async ({ id }) => {
  await deleteSigningSecret(id);
  revalidatePath("/automations");
});
