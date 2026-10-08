import {
  Bot,
  Combine,
  Hourglass,
  InfinityIcon,
  Layers,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  UserRound,
} from "lucide-react";
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

/** Whose content an entry is; labels come from memory.origins.<origin>. */
export const ORIGINS = ["owner", "agent", "untrusted", "system"] as const;
type Origin = (typeof ORIGINS)[number];

const isOrigin = (value: string): value is Origin => (ORIGINS as readonly string[]).includes(value);

/** Untrusted content stands out; the trusted origins stay quiet next to the source badge. */
export function OriginBadge({ origin }: { origin: string }) {
  const t = useTranslations("memory.origins");
  const untrusted = origin === "untrusted";
  const Icon = untrusted ? ShieldAlert : ShieldCheck;
  return (
    <Badge
      variant="secondary"
      className={cn(SUBTLE, untrusted ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}
    >
      <Icon aria-hidden />
      {isOrigin(origin) ? t(origin) : origin}
    </Badge>
  );
}

/** How long an entry holds; labels come from memory.retention.<retention>. */
const RETENTIONS = ["permanent", "durable", "ephemeral"] as const;
type Retention = (typeof RETENTIONS)[number];

const RETENTION_ICON: Record<Retention, typeof Bot> = {
  permanent: InfinityIcon,
  durable: Layers,
  ephemeral: Hourglass,
};

export function RetentionBadge({ retention }: { retention: string }) {
  const t = useTranslations("memory");
  const known = (RETENTIONS as readonly string[]).includes(retention) ? (retention as Retention) : null;
  return (
    <Badge
      variant="secondary"
      title={known ? t(`retentionHint.${known}`) : undefined}
      className={cn(SUBTLE, retention === "ephemeral" ? "bg-warning/12 text-warning" : "bg-muted text-muted-foreground")}
    >
      {known && createElement(RETENTION_ICON[known], { "aria-hidden": true })}
      {known ? t(`retention.${known}`) : retention}
    </Badge>
  );
}

/** Why a write waits for approval: a kind of memory-scan.ts, or a conflict with the user's own entry. */
const FLAG_REASON_KEYS = {
  injection: "injection",
  exfiltration: "exfiltration",
  "instruction-file": "instruction-file",
  "conflicts-with-owner": "conflictsWithOwner",
} as const;

export function FlagReason({ reason }: { reason: string }) {
  const t = useTranslations("memory.pending.flagReason");
  const key = reason in FLAG_REASON_KEYS ? FLAG_REASON_KEYS[reason as keyof typeof FLAG_REASON_KEYS] : null;
  return (
    <p className="flex items-start gap-1.5 text-xs font-medium text-destructive">
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      {key ? t(key) : reason}
    </p>
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
