import { ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ApprovalActions } from "@/components/approvals/approval-actions";
import { ToolName } from "@/components/approvals/approval-card";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { SectionCard, SectionEmpty, SectionList } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { getFormat } from "@/server/format";
import type { PendingApproval } from "@/server/queries/dashboard";

export async function PendingApprovalsCard({ approvals, total }: { approvals: PendingApproval[]; total: number }) {
  const [t, tCommon, f] = await Promise.all([
    getTranslations("dashboard.pendingApprovals"),
    getTranslations("common"),
    getFormat(),
  ]);
  return (
    <SectionCard
      icon={ShieldCheckIcon}
      title={t("title")}
      count={total}
      flush
      className="h-full"
      action={
        <Button asChild variant="ghost" size="sm">
          <Link href="/approvals">{tCommon("actions.viewAll")}</Link>
        </Button>
      }
    >
      {approvals.length === 0 ? (
        <SectionEmpty>{t("empty")}</SectionEmpty>
      ) : (
        <SectionList>
          {approvals.map((a) => (
            <li
              key={a.id}
              className="relative flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors hover:bg-muted/40 sm:px-5"
            >
              <AgentAvatar avatar={a.agentAvatar} size="lg" />
              <div className="min-w-40 flex-1">
                <Link
                  href={`/runs/${a.runId}`}
                  title={t("openRun")}
                  className="block truncate text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
                >
                  {a.agentName}
                </Link>
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <ToolName name={a.toolName} />
                  <span aria-hidden className="shrink-0">
                    ·
                  </span>
                  <span className="shrink-0">{f.relative(a.createdAt)}</span>
                </div>
              </div>
              <div className="relative z-10 ml-auto">
                <ApprovalActions id={a.id} size="xs" approveVariant="outline" />
              </div>
            </li>
          ))}
        </SectionList>
      )}
    </SectionCard>
  );
}
