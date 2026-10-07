import type { UpdateStatus } from "@abotica/core";
import { Info, Package, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { RelativeTime } from "@/components/app/relative-time";
import { SectionCard } from "@/components/app/section-card";
import { type Tone, ToneBadge } from "@/components/app/status-badge";
import { cn } from "@/lib/utils";

type State = "available" | "source" | "failed" | "upToDate" | "unchecked";

const TONE: Record<State, Tone> = {
  available: "primary",
  source: "muted",
  failed: "destructive",
  upToDate: "success",
  unchecked: "muted",
};

function stateOf(status: UpdateStatus): State {
  if (!status.current) return "source";
  if (status.available) return "available";
  if (status.error) return "failed";
  return status.latest ? "upToDate" : "unchecked";
}

/** One version in the overview: what it is, in large mono type, and a line under it. */
function VersionTile({
  label,
  value,
  muted,
  highlight,
  children,
}: {
  label: string;
  value: string;
  muted?: boolean;
  highlight?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-background/60 px-3.5 py-3 dark:bg-input/10",
        highlight && "border-primary/30 bg-primary/5 dark:bg-primary/10",
      )}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "truncate text-lg leading-tight font-semibold tracking-tight tabular-nums",
          muted && "text-muted-foreground",
          highlight && "text-primary",
        )}
      >
        {value}
      </span>
      {children && <span className="truncate text-xs text-muted-foreground">{children}</span>}
    </div>
  );
}

/** Settings > Updates: the version running here, the latest release and how the last check went. */
export function UpdateOverview({ status }: { status: UpdateStatus }) {
  const t = useTranslations("settings.updates");
  const state = stateOf(status);
  return (
    <SectionCard
      icon={Package}
      title={t("versionTitle")}
      description={t("versionDescription")}
      action={<ToneBadge tone={TONE[state]}>{t(`status.${state}`)}</ToneBadge>}
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <VersionTile
            label={t("running")}
            value={status.current ? `v${status.current}` : t("fromSource")}
            muted={!status.current}
          />
          <VersionTile
            label={t("latest")}
            value={status.latest ? `v${status.latest.version}` : t("unknown")}
            muted={!status.latest}
            highlight={status.available}
          >
            {status.latest && t.rich("published", { time: () => <RelativeTime date={status.latest!.publishedAt} /> })}
          </VersionTile>
        </div>

        {!status.current && (
          <p className="flex gap-2 text-sm text-pretty text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t("sourceNote")}
          </p>
        )}

        {status.error && (
          <p className="flex gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <span className="min-w-0 font-mono text-xs leading-5 wrap-anywhere">{status.error}</span>
          </p>
        )}

        {status.checkedAt && (
          <p className="text-xs text-muted-foreground">
            {t.rich("checked", { time: () => <RelativeTime date={status.checkedAt!} /> })}
          </p>
        )}
      </div>
    </SectionCard>
  );
}
