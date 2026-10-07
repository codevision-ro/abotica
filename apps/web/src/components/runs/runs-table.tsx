"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { RelativeTime } from "@/components/app/relative-time";
import { RunStatusBadge, useStatusLabels } from "@/components/app/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";

type RunsTableRow = {
  id: string;
  status: string;
  trigger: string;
  provider: string | null;
  model: string | null;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  agentName: string | null;
  agentAvatar: AgentAvatarValue | null;
  projectName: string | null;
};

const HEAD = "h-9 text-xs font-medium text-muted-foreground";
const WIDE = "hidden min-[1400px]:table-cell";

export function RunsTable({ rows }: { rows: RunsTableRow[] }) {
  const t = useTranslations("runs.table");
  const tAgent = useTranslations("runs.agentChip");
  const labels = useStatusLabels();
  const fmt = useFormat();
  const router = useRouter();

  return (
    <>
      <ul className="divide-y divide-border/60 md:hidden">
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              href={`/runs/${r.id}`}
              className="flex items-center gap-3 px-4 py-3.5 transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/60 active:bg-muted/60"
            >
              <AgentAvatar avatar={r.agentAvatar} size="lg" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium" title={r.agentName ?? undefined}>
                    {r.agentName ?? tAgent("deleted")}
                  </span>
                  <RunStatusBadge status={r.status} />
                </div>
                <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="min-w-0 truncate">
                    {labels.trigger(r.trigger)}
                    {" · "}
                    <RelativeTime date={r.startedAt ?? r.createdAt} />
                    {r.projectName && ` · ${r.projectName}`}
                  </span>
                  <span className="tabular shrink-0 font-medium text-foreground">{fmt.usd(r.costUsd)}</span>
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <Table className="hidden md:table">
        <TableHeader className="bg-muted/30 [&_tr]:border-border/60">
          <TableRow className="hover:bg-transparent">
            <TableHead className={cn(HEAD, "pl-5")}>{t("agent")}</TableHead>
            <TableHead className={HEAD}>{t("status")}</TableHead>
            <TableHead className={HEAD}>{t("trigger")}</TableHead>
            <TableHead className={HEAD}>{t("model")}</TableHead>
            <TableHead className={cn(HEAD, WIDE, "text-right")}>{t("steps")}</TableHead>
            <TableHead className={cn(HEAD, WIDE, "text-right")}>{t("tokens")}</TableHead>
            <TableHead className={cn(HEAD, "text-right")}>{t("cost")}</TableHead>
            <TableHead className={cn(HEAD, "hidden text-right lg:table-cell")}>{t("duration")}</TableHead>
            <TableHead className={cn(HEAD, "text-right")}>{t("started")}</TableHead>
            <TableHead className="w-10 pr-4" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow
              key={r.id}
              className="group cursor-pointer border-border/60 hover:bg-muted/40"
              onClick={() => router.push(`/runs/${r.id}`)}
            >
              <TableCell className="max-w-64 py-3 pl-5">
                <Link
                  href={`/runs/${r.id}`}
                  className="flex min-w-0 items-center gap-3 outline-none focus-visible:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  <AgentAvatar avatar={r.agentAvatar} size="lg" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium" title={r.agentName ?? undefined}>
                      {r.agentName ?? tAgent("deleted")}
                    </span>
                    {r.projectName && (
                      <span className="block truncate text-xs text-muted-foreground" title={r.projectName}>
                        {r.projectName}
                      </span>
                    )}
                  </span>
                </Link>
              </TableCell>
              <TableCell>
                <RunStatusBadge status={r.status} />
              </TableCell>
              <TableCell className="text-muted-foreground">{labels.trigger(r.trigger)}</TableCell>
              <TableCell className="max-w-48">
                {r.model ? (
                  <span className="block truncate font-mono text-xs" title={`${r.provider}/${r.model}`}>
                    {r.model}
                  </span>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </TableCell>
              <TableCell className={cn(WIDE, "tabular text-right text-muted-foreground")}>{r.steps}</TableCell>
              <TableCell className={cn(WIDE, "tabular text-right text-muted-foreground")}>
                {fmt.tokens(r.inputTokens)} / {fmt.tokens(r.outputTokens)}
              </TableCell>
              <TableCell className="tabular text-right font-medium">{fmt.usd(r.costUsd)}</TableCell>
              <TableCell className="tabular hidden text-right text-muted-foreground lg:table-cell">
                {fmt.duration(r.startedAt, r.finishedAt) || "-"}
              </TableCell>
              <TableCell className="text-right text-muted-foreground">
                <RelativeTime date={r.startedAt ?? r.createdAt} />
              </TableCell>
              <TableCell className="pr-4">
                <ChevronRight className="size-4 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
