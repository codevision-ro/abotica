"use server";

import { audit, cancelConversationRuns, cancelRun as stopRun, RUN_CANCELLED_BY_USER, startRun } from "@abotica/core";
import { UserError } from "@abotica/i18n";
import { db, runs } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "../action";

export const cancelRun = action(z.object({ id: z.string().uuid() }), async ({ id }) => {
  const run = await stopRun(id, RUN_CANCELLED_BY_USER, "cancelled_by_user");
  if (!run) throw new UserError("runs.errors.notActive");
  await audit({ actor: "user", action: "run.cancelled", entityType: "run", entityId: id });
  revalidatePath(`/runs/${id}`);
  revalidatePath("/runs");
});

/**
 * The chat's Stop: ends the conversation's active run on the server, with its tools and processes,
 * not only the stream in the browser. Returns how many runs it stopped.
 */
export const stopConversation = action(z.object({ id: z.uuid() }), async ({ id }) => {
  const stopped = await cancelConversationRuns(id, RUN_CANCELLED_BY_USER, "cancelled_by_user");
  for (const run of stopped) {
    await audit({ actor: "user", action: "run.cancelled", entityType: "run", entityId: run.id });
  }
  if (stopped.length) revalidatePath("/runs");
  return { stopped: stopped.length };
});

/** Continues the same conversation with a fresh run, linked to the failed one as parent. */
export const retryRun = action(z.object({ id: z.string().uuid() }), async ({ id }) => {
  const [run] = await db.select().from(runs).where(eq(runs.id, id));
  if (!run) throw new UserError("runs.errors.notFound");
  if (run.status !== "failed") throw new UserError("runs.errors.onlyFailedRerun");
  if (!run.conversationId) throw new UserError("runs.errors.noConversation");
  if (!run.agentId) throw new UserError("runs.errors.agentDeleted");
  const next = await startRun({
    agentId: run.agentId,
    trigger: run.trigger,
    conversationId: run.conversationId,
    taskId: run.taskId,
    projectId: run.projectId,
    parentRunId: run.id,
  });
  await audit({ actor: "user", action: "run.retried", entityType: "run", entityId: id, data: { newRunId: next.id } });
  revalidatePath("/runs");
  return { id: next.id };
});
