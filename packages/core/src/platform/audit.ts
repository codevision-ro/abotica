import { auditLogs, db } from "@abotica/db";
import type { AuditAction } from "./audit-actions";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Records an action; inside `tx` the entry is written with the change it describes, or not at all. */
export async function audit(
  entry: {
    actor: string;
    action: AuditAction;
    entityType: string;
    entityId?: string | null;
    data?: Record<string, unknown>;
  },
  tx: Tx | typeof db = db,
): Promise<void> {
  await tx.insert(auditLogs).values({ ...entry, data: entry.data ?? {} });
}
