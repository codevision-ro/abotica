import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { useTranslations } from "next-intl";
import { MessageResponse } from "@/components/ai-elements/message";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { sectionCardClass, SectionDivider } from "@/components/app/section-card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** One agent's journal for one day: the agent and the date on top, the summary below. */
export function JournalEntryCard({
  agentName,
  agentAvatar,
  summary,
  consolidated,
  day,
  dayValue,
}: {
  agentName: string;
  agentAvatar: AgentAvatarValue | null;
  summary: string;
  consolidated?: boolean;
  /** The day as shown, e.g. "Monday, 5 October 2026". */
  day: string;
  /** The day as `yyyy-MM-dd`, for the `<time>` element. */
  dayValue: string;
}) {
  const t = useTranslations("journals.entry");
  return (
    <article className={cn(sectionCardClass, "min-w-0")}>
      <header className="flex min-w-0 items-center gap-3 px-4 py-3 sm:px-5">
        <AgentAvatar avatar={agentAvatar} size="lg" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold tracking-tight" title={agentName}>
            {agentName}
          </h3>
          <time dateTime={dayValue} className="block truncate text-xs text-muted-foreground">
            {day}
          </time>
        </div>
        {consolidated && (
          <Badge variant="secondary" className="border-transparent bg-success/12 font-medium text-success">
            {t("consolidated")}
          </Badge>
        )}
      </header>
      <SectionDivider />
      <div className="min-w-0 px-4 py-3.5 text-sm wrap-anywhere sm:px-5">
        <MessageResponse>{summary}</MessageResponse>
      </div>
    </article>
  );
}
