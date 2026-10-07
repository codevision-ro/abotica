import { changedFields } from "@abotica/core";
import { MCP_ALL_KEY, TOOL_PERMISSIONS, type ToolPermissions } from "@abotica/core/agents/permissions";
import type { AgentSnapshot } from "@abotica/db";
import { GitCompareIcon, HistoryIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { SectionCard, SectionEmpty, SectionEmptyLink, SectionList, SectionRow } from "@/components/app/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Format } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getFormat } from "@/server/format";
import { getAgentVersionSnapshot, getRegistryNames, listAgentVersions } from "@/server/queries/agents";
import { RestoreVersionButton } from "./agent-actions";

type VersionsT = Awaited<ReturnType<typeof getTranslations<"agents.versions">>>;
type EffortT = Awaited<ReturnType<typeof getTranslations<"agents.effort">>>;

/** "mcp:*" -> all servers, "mcp:<slug>" -> slug, "mcp:<slug>/<tool>" -> slug/tool, built-ins as-is. */
function permissionName(key: string, t: VersionsT): string {
  if (key === MCP_ALL_KEY) return t("mcpAll");
  return key.startsWith("mcp:") ? key.slice(4) : key;
}

/** "Allow: a, b · Ask: c"; built-in denials are stored as absence, so they do not show up. */
function permissionsText(permissions: ToolPermissions, t: VersionsT): string {
  // Built-in tools first, then MCP keys.
  const keys = Object.keys(permissions).sort(
    (a, b) => Number(a.startsWith("mcp:")) - Number(b.startsWith("mcp:")) || a.localeCompare(b),
  );
  const parts = TOOL_PERMISSIONS.flatMap((p) => {
    const names = keys.filter((k) => permissions[k] === p).map((k) => permissionName(k, t));
    return names.length ? [t(`permission.${p}`, { tools: names.join(", ") })] : [];
  });
  return parts.length ? parts.join(" · ") : t("none");
}

function displayValue(
  key: keyof AgentSnapshot,
  s: AgentSnapshot,
  names: Record<string, string>,
  t: VersionsT,
  te: EffortT,
  fmt: Format,
): ReactNode {
  const list = (items: string[]) => (items.length ? items.join(", ") : t("none"));
  switch (key) {
    case "avatar":
      return <AgentAvatar avatar={s.avatar} size="md" />;
    case "fallbacks":
      return list(s.fallbacks.map((f) => `${f.provider}/${f.model}`));
    case "provider":
    case "model":
      return s[key] ?? t("default");
    case "reasoningEffort":
      // Snapshots saved before these fields existed have neither; "default" follows settings.
      return s.reasoningEffort && s.reasoningEffort !== "default"
        ? te(`options.${s.reasoningEffort}.label`)
        : te("fromSettings");
    case "permissions":
      return permissionsText(s.permissions ?? {}, t);
    case "skillIds":
    case "mcpServerIds":
      return list((s[key] ?? []).map((id) => names[id] ?? t("deleted")));
    case "limits":
      return t("limits", {
        steps: s.limits.maxSteps,
        minutes: Math.round(s.limits.timeoutMs / 60_000),
        budget: s.limits.budgetUsd == null ? t("unlimited") : fmt.usd(s.limits.budgetUsd),
      });
    default:
      return String(s[key] ?? "");
  }
}

export async function AgentVersionsTab({
  agentId,
  currentVersion,
  current,
  selected,
}: {
  agentId: string;
  currentVersion: number;
  current: AgentSnapshot;
  selected?: number;
}) {
  const [versions, t, te, fmt] = await Promise.all([
    listAgentVersions(agentId),
    getTranslations("agents.versions"),
    getTranslations("agents.effort"),
    getFormat(),
  ]);
  const picked = versions.find((v) => v.version === selected);
  const [snapshot, names] = picked
    ? await Promise.all([getAgentVersionSnapshot(agentId, picked.version), getRegistryNames()])
    : [null, {}];
  const diff = snapshot ? changedFields(snapshot, current) : [];

  return (
    <div className="flex flex-col gap-6">
      <SectionCard icon={HistoryIcon} title={t("title")} count={versions.length} description={t("description")} flush>
        {versions.length ? (
          <SectionList>
            {versions.map((v) => {
              const isCurrent = v.version === currentVersion;
              const isSelected = v.version === selected;
              return (
                <SectionRow
                  key={v.id}
                  className={cn(isSelected && "bg-primary/5 hover:bg-primary/5 dark:bg-primary/10")}
                  media={
                    <span
                      className={cn(
                        "tabular flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold",
                        isCurrent ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                      )}
                    >
                      v{v.version}
                    </span>
                  }
                  title={
                    <span title={v.note || undefined}>
                      {v.note || <span className="font-normal text-muted-foreground">{t("noNote")}</span>}
                    </span>
                  }
                  subtitle={fmt.dateTime(v.createdAt)}
                  trailing={
                    isCurrent ? (
                      <Badge variant="secondary" className="bg-primary/10 font-normal text-primary">
                        {t("currentLabel")}
                      </Badge>
                    ) : (
                      <>
                        <Button variant={isSelected ? "secondary" : "ghost"} size="sm" asChild>
                          {isSelected ? (
                            <Link href={`/agents/${agentId}?tab=versions`} scroll={false} aria-label={t("hideCompare")}>
                              <XIcon /> <span className="hidden sm:inline">{t("hideCompare")}</span>
                            </Link>
                          ) : (
                            <Link
                              href={`/agents/${agentId}?tab=versions&v=${v.version}#version-diff`}
                              aria-label={t("compare")}
                            >
                              <GitCompareIcon /> <span className="hidden sm:inline">{t("compare")}</span>
                            </Link>
                          )}
                        </Button>
                        <RestoreVersionButton id={agentId} version={v.version} />
                      </>
                    )
                  }
                />
              );
            })}
          </SectionList>
        ) : (
          <SectionEmpty>
            {t("emptyState", { version: currentVersion })}{" "}
            <SectionEmptyLink href={`/agents/${agentId}?tab=config`}>{t("openConfig")}</SectionEmptyLink>
          </SectionEmpty>
        )}
      </SectionCard>

      {picked && snapshot && (
        <div id="version-diff" className="scroll-mt-20">
          <SectionCard
            icon={GitCompareIcon}
            title={t("diffTitle", { version: picked.version, current: currentVersion })}
            description={diff.length ? t("diffCount", { count: diff.length }) : undefined}
          >
            {diff.length ? (
              <div className="flex flex-col gap-5">
                {diff.map((key) => (
                  <div key={key} className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium">{t(`fields.${key}`)}</h3>
                    <div className="grid gap-2 md:grid-cols-2">
                      <DiffBlock
                        title={`v${picked.version}`}
                        value={displayValue(key, snapshot, names, t, te, fmt)}
                        empty={t("empty")}
                        pre={key === "systemPrompt"}
                        tone="old"
                      />
                      <DiffBlock
                        title={t("currentLabel")}
                        value={displayValue(key, current, names, t, te, fmt)}
                        empty={t("empty")}
                        pre={key === "systemPrompt"}
                        tone="new"
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noDiff")}</p>
            )}
          </SectionCard>
        </div>
      )}
    </div>
  );
}

function DiffBlock({
  title,
  value,
  empty,
  pre,
  tone,
}: {
  title: string;
  value: ReactNode;
  empty: string;
  pre: boolean;
  tone: "old" | "new";
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border p-3",
        tone === "old"
          ? "border-destructive/20 bg-destructive/[0.04] dark:bg-destructive/[0.08]"
          : "border-success/25 bg-success/[0.05] dark:bg-success/[0.08]",
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <span aria-hidden className={cn("size-1.5 rounded-full", tone === "old" ? "bg-destructive/70" : "bg-success")} />
        {title}
      </div>
      {pre ? (
        <pre className="max-h-96 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">
          {value || empty}
        </pre>
      ) : (
        <div className="text-sm wrap-anywhere">{value || empty}</div>
      )}
    </div>
  );
}
