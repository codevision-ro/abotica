import { ActivityIcon, BookOpenIcon, BrainIcon, CrownIcon, ListTodoIcon, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { RelativeTime } from "@/components/app/relative-time";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { MemberActivity } from "@/server/queries/projects";

/** Marks the agent that leads a project. */
export function ManagerBadge({ className }: { className?: string }) {
  const t = useTranslations("team");
  return (
    <Badge variant="secondary" className={cn("gap-1 border-transparent bg-primary/10 font-medium text-primary", className)}>
      <CrownIcon aria-hidden />
      {t("manager")}
    </Badge>
  );
}

function Stat({ icon: Icon, muted, children }: { icon: LucideIcon; muted: boolean; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", muted && "text-muted-foreground/70")}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * What an agent did in one project: memories it wrote there, journal days, open tasks and its latest run.
 * Zero counts are dimmed so the ones that matter stand out.
 */
export function MemberActivityStats({ activity }: { activity: MemberActivity }) {
  const t = useTranslations("team.activity");
  const lastActiveAt = activity.lastActiveAt;
  return (
    <div className="tabular flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      <Stat icon={BrainIcon} muted={!activity.memories}>
        {t("memories", { count: activity.memories })}
      </Stat>
      <Stat icon={BookOpenIcon} muted={!activity.journalDays}>
        {t("journalDays", { count: activity.journalDays })}
      </Stat>
      <Stat icon={ListTodoIcon} muted={!activity.openTasks}>
        {t("openTasks", { count: activity.openTasks })}
      </Stat>
      <Stat icon={ActivityIcon} muted={!lastActiveAt}>
        {lastActiveAt ? t.rich("lastActive", { time: () => <RelativeTime date={lastActiveAt} /> }) : t("neverActive")}
      </Stat>
    </div>
  );
}
