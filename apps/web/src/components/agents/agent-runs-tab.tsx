import { ActivityIcon, ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SectionCard, SectionEmpty, SectionList, SectionRow } from "@/components/app/section-card";
import { RunStatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getFormat } from "@/server/format";
import { listAgentRuns } from "@/server/queries/agents";

export async function AgentRunsTab({ agentId }: { agentId: string }) {
  const [runs, t, tr, fmt] = await Promise.all([
    listAgentRuns(agentId),
    getTranslations("agents.runs"),
    getTranslations("common.trigger"),
    getFormat(),
  ]);
  const triggerLabel = (trigger: string) => {
    const key = trigger as Parameters<typeof tr>[0];
    return tr.has(key) ? tr(key) : trigger;
  };
  const allRuns = `/runs?agent=${agentId}`;
  return (
    <SectionCard
      icon={ActivityIcon}
      title={t("title")}
      count={runs.length}
      description={t("description")}
      flush
      action={
        runs.length > 0 && (
          <Button variant="ghost" size="sm" asChild>
            <Link href={allRuns}>
              {t("all")} <ArrowRightIcon />
            </Link>
          </Button>
        )
      }
    >
      {runs.length ? (
        <>
          <SectionList className="md:hidden">
            {runs.map((r) => (
              <SectionRow
                key={r.id}
                href={`/runs/${r.id}`}
                title={
                  <span className="flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate">{r.input || triggerLabel(r.trigger)}</span>
                    <RunStatusBadge status={r.status} />
                  </span>
                }
                subtitle={
                  <span className="tabular">
                    {[r.input ? triggerLabel(r.trigger) : null, r.model, fmt.usd(r.costUsd), fmt.relative(r.createdAt)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                }
              />
            ))}
          </SectionList>
          <Table className="hidden md:table">
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="pl-5 text-xs font-medium text-muted-foreground">{t("status")}</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground">{t("trigger")}</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground">{t("input")}</TableHead>
                <TableHead className="text-xs font-medium text-muted-foreground">{t("model")}</TableHead>
                <TableHead className="text-right text-xs font-medium text-muted-foreground">{t("cost")}</TableHead>
                <TableHead className="text-right text-xs font-medium text-muted-foreground">{t("duration")}</TableHead>
                <TableHead className="pr-5 text-right text-xs font-medium text-muted-foreground">{t("when")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={r.id} className="relative h-12 border-border/60 hover:bg-muted/40">
                  <TableCell className="pl-5">
                    <Link
                      href={`/runs/${r.id}`}
                      className="outline-none after:absolute after:inset-0 focus-visible:after:ring-3 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
                      aria-label={t("open")}
                    >
                      <RunStatusBadge status={r.status} />
                    </Link>
                  </TableCell>
                  <TableCell>{triggerLabel(r.trigger)}</TableCell>
                  <TableCell className="max-w-72 min-w-40 truncate text-muted-foreground" title={r.input || undefined}>
                    {r.input}
                  </TableCell>
                  <TableCell className="max-w-56 truncate font-mono text-xs" title={r.model ?? undefined}>
                    {r.model ?? ""}
                  </TableCell>
                  <TableCell className="tabular text-right">{fmt.usd(r.costUsd)}</TableCell>
                  <TableCell className="tabular text-right">{fmt.duration(r.startedAt, r.finishedAt)}</TableCell>
                  <TableCell className="pr-5 text-right text-muted-foreground" title={fmt.dateTime(r.createdAt)}>
                    {fmt.relative(r.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      ) : (
        <SectionEmpty>{t("empty")}</SectionEmpty>
      )}
    </SectionCard>
  );
}
