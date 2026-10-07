import { auditLogs, db } from "@abotica/db";
import type { AuditAction } from "./audit-actions";

export async function audit(entry: {
  actor: string;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLogs).values({ ...entry, data: entry.data ?? {} });
}
