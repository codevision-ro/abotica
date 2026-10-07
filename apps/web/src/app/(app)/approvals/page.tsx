import { ChevronRight, History, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { sectionCardClass, SectionIcon, SectionList } from "@/components/app/section-card";
import { ApprovalCard, ToolName } from "@/components/approvals/approval-card";
import { ApprovalStatusBadge } from "@/components/approvals/approval-status-badge";
import { ApprovalTabs } from "@/components/approvals/approval-tabs";
import { Badge } from "@/components/ui/badge";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { getFormat } from "@/server/format";
import { listPendingApprovals } from "@/server/queries/dashboard";
import { listApprovalHistory } from "@/server/queries/runs";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("approvals");
  return { title: t("meta.title") };
}

export default async function ApprovalsPage(props: PageProps<"/approvals">) {
  const sp = await props.searchParams;
  const [pending, history] = await Promise.all([listPendingApprovals(), listApprovalHistory()]);
  const [t, fmt] = await Promise.all([getTranslations("approvals"), getFormat()]);
  const tab = sp.tab === "history" ? "history" : "pending";

  return (
    <PageBody>
      <PageHeader title={t("page.title")} description={t("page.description")} />
      <ApprovalTabs defaultValue={tab}>
        <TabsList>
          <TabsTrigger value="pending">
            {t("tabs.pending")}
            {pending.length > 0 && (
              <Badge variant="secondary" className="tabular h-4 min-w-4 bg-primary/10 px-1 text-primary">
                {pending.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="history">{t("tabs.history")}</TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="mt-4">
          {pending.length === 0 ? (
            <div className={cn(sectionCardClass, "flex items-center gap-3 px-4 py-3.5 sm:px-5")}>
              <SectionIcon icon={ShieldCheck} />
              <p className="min-w-0 text-sm text-muted-foreground">{t("pending.empty")}</p>
            </div>
          ) : (
            <div className="grid gap-4">
              {pending.map((a) => (
                <ApprovalCard key={a.id} approval={a} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          {history.length === 0 ? (
            <div className={cn(sectionCardClass, "flex items-center gap-3 px-4 py-3.5 sm:px-5")}>
              <SectionIcon icon={History} />
              <p className="min-w-0 text-sm text-muted-foreground">{t("history.empty")}</p>
            </div>
          ) : (
            <div className={cn(sectionCardClass, "overflow-hidden")}>
              <SectionList>
                {history.map((a) => (
                  <li key={a.id}>
                    <Link
                      href={`/runs/${a.runId}`}
                      title={t("history.openRun")}
                      className="group flex min-w-0 items-center gap-3 px-4 py-3 transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                    >
                      <AgentAvatar avatar={a.agentAvatar} size="lg" />
                      <div className="min-w-0 flex-1 md:grid md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:items-center md:gap-4">
                        <div className="truncate text-sm font-medium" title={a.agentName}>
                          {a.agentName}
                        </div>
                        <div className="flex min-w-0 text-xs text-muted-foreground md:text-sm md:text-foreground">
                          <ToolName name={a.toolName} />
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1 md:flex-row md:items-center md:gap-4">
                        <ApprovalStatusBadge status={a.status} />
                        <time
                          dateTime={(a.decidedAt ?? a.createdAt).toISOString()}
                          title={[
                            t("history.requestedAt", { time: fmt.dateTime(a.createdAt) }),
                            a.decidedAt && t("history.decidedAt", { time: fmt.dateTime(a.decidedAt) }),
                          ]
                            .filter(Boolean)
                            .join("\n")}
                          className="tabular text-xs whitespace-nowrap text-muted-foreground md:w-32 md:text-right"
                        >
                          {fmt.relative(a.decidedAt ?? a.createdAt)}
                        </time>
                      </div>
                      <ChevronRight className="hidden size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground md:block" />
                    </Link>
                  </li>
                ))}
              </SectionList>
            </div>
          )}
        </TabsContent>
      </ApprovalTabs>
    </PageBody>
  );
}
