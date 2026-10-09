import { ActivityIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { SectionCard, SectionEmpty, SectionEmptyLink, SectionList, SectionRow } from "@/components/app/section-card";
import { RunStatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { getFormat } from "@/server/format";
import type { RunRow } from "@/server/queries/runs";

const chatLink = (chunks: React.ReactNode) => <SectionEmptyLink href="/chat">{chunks}</SectionEmptyLink>;

export async function RecentRunsCard({ runs, className }: { runs: RunRow[]; className?: string }) {
  const [t, tCommon, tAgent, f] = await Promise.all([
    getTranslations("dashboard.recentRuns"),
    getTranslations("common"),
    getTranslations("runs.agentChip"),
    getFormat(),
  ]);
  const trigger = (value: string) => {
    const key = `trigger.${value}` as Parameters<typeof tCommon>[0];
    return tCommon.has(key) ? tCommon(key) : value;
  };
  return (
    <SectionCard
      icon={ActivityIcon}
      title={t("title")}
      flush
      className={className}
      action={
        runs.length > 0 && (
          <Button asChild variant="ghost" size="sm">
            <Link href="/runs">{t("seeAll")}</Link>
          </Button>
        )
      }
    >
      {runs.length === 0 ? (
        <SectionEmpty>{t.rich("empty", { link: chatLink })}</SectionEmpty>
      ) : (
        <SectionList>
          {runs.map((r) => (
            <SectionRow
              key={r.id}
              href={`/runs/${r.id}`}
              media={<AgentAvatar avatar={r.agentAvatar} size="lg" />}
              title={r.agentName ?? tAgent("deleted")}
              subtitle={[trigger(r.trigger), r.projectName, f.relative(r.createdAt)].filter(Boolean).join(" · ")}
              trailing={
                <>
                  <span className="tabular hidden text-xs text-muted-foreground sm:inline">{f.usd(r.costUsd)}</span>
                  <RunStatusBadge status={r.status} />
                </>
              }
            />
          ))}
        </SectionList>
      )}
    </SectionCard>
  );
}
