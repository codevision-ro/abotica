import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const APPROVAL_STATUS_CLASS: Record<string, string> = {
  pending: "bg-warning/15 text-[color-mix(in_oklch,var(--warning),black_35%)] dark:text-warning",
  approved: "bg-success/12 text-success",
  rejected: "bg-destructive/10 text-destructive",
  expired: "bg-muted text-muted-foreground",
};

export function ApprovalStatusBadge({ status }: { status: string }) {
  const t = useTranslations("approvals.status");
  const key = status as Parameters<typeof t>[0];
  const className = APPROVAL_STATUS_CLASS[status] ?? "bg-muted text-muted-foreground";
  return (
    <Badge variant="secondary" className={cn("gap-1.5 border-transparent font-medium", className)}>
      <span className="size-1.5 rounded-full bg-current" />
      {t.has(key) ? t(key) : status}
    </Badge>
  );
}
