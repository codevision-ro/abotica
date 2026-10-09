import { ArrowRightIcon, CalendarClockIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { countAgentSchedules } from "@/server/queries/agents";
import { AgentJournalTab } from "./agent-journal-tab";
import { AgentRunsTab } from "./agent-runs-tab";

/** What the agent did: its latest runs, a link to its schedules in Automations, and its journal. */
export async function AgentActivityTab({
  agentId,
  query,
  project,
}: {
  agentId: string;
  query: string;
  /** Journal filter in `?project=`: a project id, "none" for work outside projects; empty for all. */
  project: string;
}) {
  const [schedules, t] = await Promise.all([countAgentSchedules(agentId), getTranslations("agents.activity")]);
  return (
    <div className="flex flex-col gap-5">
      <AgentRunsTab agentId={agentId} />
      <Link
        href={`/automations?agent=${agentId}`}
        className="group flex items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <CalendarClockIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">{t("schedules", { count: schedules })}</span>
        <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground group-hover:text-foreground">
          {t("openAutomations")}
          <ArrowRightIcon className="size-4" aria-hidden />
        </span>
      </Link>
      <AgentJournalTab agentId={agentId} query={query} project={project} />
    </div>
  );
}
