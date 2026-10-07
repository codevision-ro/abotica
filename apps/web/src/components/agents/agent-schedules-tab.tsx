import { ArrowRightIcon, CalendarClockIcon, CalendarIcon, RepeatIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  SectionCard,
  SectionEmpty,
  SectionEmptyLink,
  SectionIcon,
  SectionList,
  SectionRow,
} from "@/components/app/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getFormat } from "@/server/format";
import { listAgentSchedules } from "@/server/queries/agents";

export async function AgentSchedulesTab({ agentId }: { agentId: string }) {
  const [rows, t, fmt] = await Promise.all([listAgentSchedules(agentId), getTranslations("agents.schedules"), getFormat()]);
  const lastRun = (at: Date | null) => (at ? t("lastRun", { time: fmt.relative(at) }) : t("never"));
  return (
    <SectionCard
      icon={CalendarClockIcon}
      title={t("title")}
      count={rows.length}
      description={t("description")}
      flush
      action={
        rows.length > 0 && (
          <Button variant="ghost" size="sm" asChild>
            <Link href="/automations">
              {t("manage")} <ArrowRightIcon />
            </Link>
          </Button>
        )
      }
    >
      {rows.length ? (
        <SectionList>
          {rows.map((s) => (
            <SectionRow
              key={s.id}
              media={<SectionIcon icon={s.kind === "cron" ? RepeatIcon : CalendarIcon} />}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate" title={s.name}>
                    {s.name}
                  </span>
                  {!s.enabled && (
                    <Badge variant="secondary" className="font-normal">
                      {t("disabled")}
                    </Badge>
                  )}
                </span>
              }
              subtitle={
                <>
                  {s.kind === "cron" ? (
                    <>
                      <span className="font-mono">{s.cron}</span> ({s.timezone})
                    </>
                  ) : (
                    t("once", { date: fmt.dateTime(s.runAt) })
                  )}
                  {s.projectName && ` · ${s.projectName}`}
                  <span className="sm:hidden"> · {lastRun(s.lastRunAt)}</span>
                </>
              }
              trailing={<span className="hidden text-xs text-muted-foreground sm:inline">{lastRun(s.lastRunAt)}</span>}
            />
          ))}
        </SectionList>
      ) : (
        <SectionEmpty>
          {t("empty")} <SectionEmptyLink href="/automations">{t("manage")}</SectionEmptyLink>
        </SectionEmpty>
      )}
    </SectionCard>
  );
}
