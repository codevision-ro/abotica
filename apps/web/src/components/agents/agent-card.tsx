import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { ActivityIcon, FolderKanbanIcon, WalletIcon } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { ToneBadge } from "@/components/app/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createFormat } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AgentEnabledSwitch } from "./agent-actions";

/** Same card as the MCP and project lists: quiet border, primary tint on hover. */
const CARD =
  "group relative flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40";

export function ModelBadge({ provider, model }: { provider: string | null; model: string | null }) {
  const t = useTranslations("agents.card");
  if (!provider || !model) {
    return (
      <Badge variant="secondary" className="max-w-full min-w-0 shrink font-normal">
        <span className="truncate">{t("defaultModel")}</span>
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="max-w-full min-w-0 shrink font-mono font-normal" title={`${provider}/${model}`}>
      <span className="truncate">
        {provider}/{model}
      </span>
    </Badge>
  );
}

type CardAgent = {
  id: string;
  slug: string;
  name: string;
  role: string;
  avatar: AgentAvatarValue;
  provider: string | null;
  model: string | null;
  isOrchestrator: boolean;
  enabled: boolean;
  runs7d: number;
  cost30d: number;
  running: boolean;
  projects: { id: string; name: string }[];
};

/** Avatar, name and role, the avatar centered on the two lines; the name link covers the whole card. */
function CardIdentity({
  href,
  agent,
  noRole,
}: {
  href: string;
  agent: Pick<CardAgent, "name" | "role" | "avatar">;
  noRole: string;
}) {
  return (
    <>
      <AgentAvatar avatar={agent.avatar} size="xl" />
      <div className="min-w-0 flex-1">
        <Link
          href={href}
          title={agent.name}
          className="line-clamp-2 font-medium wrap-anywhere outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
        >
          {agent.name}
        </Link>
        <p className="truncate text-sm text-muted-foreground" title={agent.role || undefined}>
          {agent.role || noRole}
        </p>
      </div>
    </>
  );
}

export function AgentCard({ agent }: { agent: CardAgent }) {
  const t = useTranslations("agents.card");
  const fmt = createFormat(useLocale());
  const projects = agent.projects.map((p) => p.name).join(", ");
  return (
    <div className={cn(CARD, !agent.enabled && "opacity-70")}>
      <div className="flex items-center gap-3">
        <CardIdentity href={`/agents/${agent.id}`} agent={agent} noRole={t("noRole")} />
        <div className="relative z-10">
          <AgentEnabledSwitch id={agent.id} enabled={agent.enabled} locked={agent.isOrchestrator} />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {agent.running && (
          <ToneBadge tone="primary" pulse title={t("runningNow")}>
            {t("running")}
          </ToneBadge>
        )}
        {agent.isOrchestrator && <Badge>{t("orchestrator")}</Badge>}
        <ModelBadge provider={agent.provider} model={agent.model} />
      </div>

      <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <FolderKanbanIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate" title={projects || undefined}>
          {projects || t("noProjects")}
        </span>
      </p>

      <div className="tabular mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <ActivityIcon className="size-3.5" aria-hidden />
          {t.rich("runs7d", {
            count: agent.runs7d,
            b: (chunks) => <b className="font-medium text-foreground">{chunks}</b>,
          })}
        </span>
        <span className="inline-flex items-center gap-1">
          <WalletIcon className="size-3.5" aria-hidden />
          {t.rich("cost30d", {
            cost: fmt.usd(agent.cost30d),
            b: (chunks) => <b className="font-medium text-foreground">{chunks}</b>,
          })}
        </span>
      </div>
    </div>
  );
}

export function TemplateCard({
  agent,
}: {
  agent: Pick<CardAgent, "id" | "slug" | "name" | "role" | "avatar" | "provider" | "model">;
}) {
  const t = useTranslations("agents.card");
  return (
    <div className={cn(CARD, "gap-3")}>
      <div className="flex items-center gap-3">
        <CardIdentity href={`/agents/${agent.id}`} agent={agent} noRole={t("noRole")} />
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 border-t pt-3">
        <div className="flex min-w-0 flex-1">
          <ModelBadge provider={agent.provider} model={agent.model} />
        </div>
        <Button size="sm" variant="outline" className="relative z-10 shrink-0" asChild>
          <Link href={`/agents/new?template=${agent.slug}`}>{t("use")}</Link>
        </Button>
      </div>
    </div>
  );
}
