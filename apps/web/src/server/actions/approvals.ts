"use server";

import { decideApproval as decideApprovalRow } from "@abotica/core";
import { approvals, db } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "../action";

/** Approves or denies a pending tool call, by row id (approvals page) or by the SDK approval id (chat). */
export const decideApproval = action(
  z.object({
    id: z.string().uuid().optional(),
    approvalId: z.string().optional(),
    approved: z.boolean(),
    reason: z.string().optional(),
  }),
  async ({ id, approvalId, approved, reason }) => {
    let rowId = id;
    if (!rowId && approvalId) {
      const [row] = await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.approvalId, approvalId));
      rowId = row?.id;
    }
    if (!rowId) throw new UserError("chat.errors.approvalNotFound");
    const result = await decideApprovalRow(rowId, approved, { reason, actor: "user" });
    if (!result) throw new UserError("chat.errors.approvalAlreadyDecided");
    revalidatePath("/approvals");
    return { continued: result.continued };
  },
);
