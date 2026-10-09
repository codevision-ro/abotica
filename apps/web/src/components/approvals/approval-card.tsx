import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { ArrowUpRight, Plug, Wrench } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { sectionCardClass, SectionDivider } from "@/components/app/section-card";
import { Badge } from "@/components/ui/badge";
import { createFormat } from "@/lib/format";
import { cn } from "@/lib/utils";
import { JsonBlock } from "../runs/json-block";
import { ApprovalActions } from "./approval-actions";
import { useToolLabel } from "./tool-label";

type ApprovalCardData = {
  id: string;
  runId: string;
  toolName: string;
  input: unknown;
  reason: string | null;
  createdAt: Date;
  agentName: string;
  agentAvatar: AgentAvatarValue;
};

export function ToolName({ name }: { name: string }) {
  const tool = useToolLabel()(name);
  return (
    <span
      className="inline-flex max-w-full min-w-0 items-center gap-1.5"
      title={tool.server ? `${tool.label} (MCP: ${tool.server})` : tool.label}
    >
      {tool.server ? (
        <Plug className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 truncate font-medium">{tool.label}</span>
      {tool.server && (
        <Badge variant="outline" className="max-w-40 min-w-14 shrink-[3] font-normal">
          <span className="truncate">MCP: {tool.server}</span>
        </Badge>
      )}
    </span>
  );
}

/** Sync and free of server-only imports because ToolName, from this file, is shared with other screens. */
export function ApprovalCard({ approval }: { approval: ApprovalCardData }) {
  const t = useTranslations("approvals.card");
  const fmt = createFormat(useLocale());
  return (
    <article className={cn(sectionCardClass, "min-w-0")}>
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <AgentAvatar avatar={approval.agentAvatar} size="lg" className="size-9" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" title={approval.agentName}>
            {approval.agentName}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-sm">
            {t.rich("wantsToUse", {
              muted: (chunks) => <span className="shrink-0 text-muted-foreground">{chunks}</span>,
              tool: () => <ToolName name={approval.toolName} />,
            })}
          </div>
        </div>
        <time
          dateTime={approval.createdAt.toISOString()}
          title={fmt.dateTime(approval.createdAt)}
          className="hidden shrink-0 self-start pt-0.5 text-xs text-muted-foreground sm:block"
        >
          {fmt.relative(approval.createdAt)}
        </time>
      </div>
      <SectionDivider />
      <div className="space-y-3 p-4 sm:p-5">
        {approval.reason && <p className="text-sm leading-6 wrap-anywhere">{approval.reason}</p>}
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">{t("arguments")}</div>
          <JsonBlock value={approval.input} className="max-h-56" />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <time dateTime={approval.createdAt.toISOString()} title={fmt.dateTime(approval.createdAt)} className="sm:hidden">
            {fmt.relative(approval.createdAt)}
          </time>
          <Link
            href={`/runs/${approval.runId}`}
            className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("viewRun")}
            <ArrowUpRight className="size-3" />
          </Link>
        </div>
        <div className="ml-auto">
          <ApprovalActions id={approval.id} />
        </div>
      </div>
    </article>
  );
}
