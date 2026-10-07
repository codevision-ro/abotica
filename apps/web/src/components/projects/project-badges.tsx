import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { useTranslations } from "next-intl";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const PROJECT_STATUSES = ["active", "paused", "archived"] as const;
type ProjectStatus = (typeof PROJECT_STATUSES)[number];
const isProjectStatus = (value: string): value is ProjectStatus => (PROJECT_STATUSES as readonly string[]).includes(value);

const PROJECT_STATUS_CLASS: Record<string, string> = {
  active: "bg-success/12 text-success",
  paused: "bg-warning/15 text-[color-mix(in_oklch,var(--warning),black_35%)] dark:text-warning",
  archived: "bg-muted text-muted-foreground",
};

/** Project status label in the current language; unknown values are shown as-is. */
export function useProjectStatusLabel() {
  const t = useTranslations("projects.status");
  return (status: string) => (isProjectStatus(status) ? t(status) : status);
}

export function ProjectStatusBadge({ status }: { status: string }) {
  const label = useProjectStatusLabel();
  return (
    <Badge
      variant="secondary"
      className={cn(
        "gap-1.5 border-transparent font-medium",
        PROJECT_STATUS_CLASS[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {label(status)}
    </Badge>
  );
}

/** Overlapping avatars for a list of agents. */
export function AgentAvatarStack({
  agents,
  max = 5,
}: {
  agents: { id: string; name: string; avatar: AgentAvatarValue }[];
  max?: number;
}) {
  const t = useTranslations("projects.badges");
  if (!agents.length) return <span className="text-xs text-muted-foreground">{t("noAgents")}</span>;
  const shown = agents.slice(0, max);
  const rest = agents.length - shown.length;
  return (
    <div className="flex items-center -space-x-1.5">
      {shown.map((a) => (
        <span key={a.id} title={a.name} className="rounded-lg ring-2 ring-card">
          <AgentAvatar avatar={a.avatar} size="md" />
        </span>
      ))}
      {rest > 0 && (
        <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-xs font-medium text-muted-foreground ring-2 ring-card">
          +{rest}
        </span>
      )}
    </div>
  );
}
