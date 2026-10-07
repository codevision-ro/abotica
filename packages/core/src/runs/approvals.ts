import { approvals, db, messages, runs } from "@abotica/db";
import { and, eq } from "@abotica/db/orm";
import { audit } from "../platform/audit";
import { publish } from "../infra/events";
import { ConversationBusyError, requestResume, startContinuation } from "./runs";

export type Approval = typeof approvals.$inferSelect;

type ApprovalPart = { approval?: { id: string; approved?: boolean; reason?: string }; state?: string };

/** Marks the matching tool part as responded, which is what the SDK replays on resume. */
async function patchApprovalPart(conversationId: string, approvalId: string, approved: boolean, reason?: string) {
  const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
  for (const row of rows) {
    let changed = false;
    const parts = (row.parts as ApprovalPart[]).map((part) => {
      if (part.approval?.id !== approvalId || part.state !== "approval-requested") return part;
      changed = true;
      return { ...part, state: "approval-responded", approval: { ...part.approval, approved, reason } };
    });
    if (changed) {
      await db.update(messages).set({ parts }).where(eq(messages.id, row.id));
      return;
    }
  }
}

/**
 * Moves a run waiting for approvals on, at most once: when the last two approvals are decided
 * together, only the decision whose update wins starts the continuation. "running": the approvals
 * were decided before the run reached waiting_approval.
 */
async function claimContinuation(runId: string): Promise<"claimed" | "running" | "taken"> {
  for (;;) {
    const [moved] = await db
      .update(runs)
      .set({ status: "succeeded" })
      .where(and(eq(runs.id, runId), eq(runs.status, "waiting_approval")))
      .returning({ id: runs.id });
    if (moved) return "claimed";
    const [current] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    // It reached waiting_approval between the two queries: try again.
    if (current?.status === "waiting_approval") continue;
    return current?.status === "running" ? "running" : "taken";
  }
}

/**
 * Records a decision. When the last pending approval of a run is decided, a continuation
 * run starts on the same conversation: approved tools execute, denied ones are reported.
 */
export async function decideApproval(
  id: string,
  approved: boolean,
  opts: { reason?: string; actor?: string } = {},
): Promise<{ approval: Approval; continued: boolean } | null> {
  const [approval] = await db
    .update(approvals)
    .set({ status: approved ? "approved" : "rejected", decidedAt: new Date() })
    .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
    .returning();
  if (!approval) return null;

  const [run] = await db.select().from(runs).where(eq(runs.id, approval.runId));
  if (!run?.conversationId) return { approval, continued: false };

  await patchApprovalPart(run.conversationId, approval.approvalId, approved, opts.reason);
  await audit({
    actor: opts.actor ?? "user",
    action: approved ? "approval.approved" : "approval.rejected",
    entityType: "approval",
    entityId: id,
    data: { tool: approval.toolName },
  });
  await publish({ type: "approval.decided", approvalId: id, status: approval.status });

  const stillPending = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.runId, run.id), eq(approvals.status, "pending")));
  if (stillPending.length) return { approval, continued: false };

  const next = await claimContinuation(run.id);
  if (next === "running") {
    // Decided before the run ended its turn: it continues in a follow-up once it ends.
    await requestResume(run.conversationId);
    return { approval, continued: true };
  }
  // A deleted agent's approvals go with it, so a run without an agent has nothing left to continue.
  if (next === "taken" || !run.agentId) return { approval, continued: false };
  try {
    await startContinuation({
      agentId: run.agentId,
      trigger: run.trigger,
      conversationId: run.conversationId,
      taskId: run.taskId,
      projectId: run.projectId,
      parentRunId: run.id,
    });
  } catch (error) {
    if (!(error instanceof ConversationBusyError)) throw error;
    // Another run is answering in this conversation; continue right after it.
    await requestResume(run.conversationId);
  }
  return { approval, continued: true };
}
