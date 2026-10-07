import { Bot, Combine, UserRound } from "lucide-react";
import { createElement } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const SCOPES = ["global", "project", "agent"] as const;

/** Labels come from memory.sources.<source>. */
const SOURCES = ["manual", "agent", "consolidation"] as const;
type Source = (typeof SOURCES)[number];

const SOURCE_CLASS: Record<Source, string> = {
  manual: "bg-muted text-muted-foreground",
  agent: "bg-primary/10 text-primary",
  consolidation: "bg-success/12 text-success",
};

const SOURCE_ICON: Record<Source, typeof Bot> = { manual: UserRound, agent: Bot, consolidation: Combine };

const SUBTLE = "h-4.5 border-transparent px-1.5 text-[11px] font-medium";

export function SourceBadge({ source }: { source: string }) {
  const t = useTranslations("memory.sources");
  const known = (SOURCES as readonly string[]).includes(source) ? (source as Source) : null;
  return (
    <Badge variant="secondary" className={cn(SUBTLE, known ? SOURCE_CLASS[known] : "bg-muted text-muted-foreground")}>
      {known && createElement(SOURCE_ICON[known], { "aria-hidden": true })}
      {known ? t(known) : source}
    </Badge>
  );
}

export function ScopeBadge({ scope }: { scope: string }) {
  const t = useTranslations("memory.scopes");
  return (
    <Badge variant="outline" className={cn(SUBTLE, "border-border text-foreground/80")}>
      {(SCOPES as readonly string[]).includes(scope) ? t(scope as (typeof SCOPES)[number]) : scope}
    </Badge>
  );
}

export function PendingBadge() {
  const t = useTranslations("memory.list");
  return (
    <Badge variant="secondary" className={cn(SUBTLE, "bg-warning/15 text-warning")}>
      {t("pending")}
    </Badge>
  );
}
