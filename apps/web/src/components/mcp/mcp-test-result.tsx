"use client";

import { CircleCheckIcon, CircleXIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { McpTestResult } from "@/server/actions/mcp";

/** Same prefixing as core loadMcpTools, so the user sees the exact names agents get. */
const mcpToolName = (slug: string, tool: string) => `${slug.replace(/[^a-zA-Z0-9]/g, "_")}__${tool}`;

/** One tool, titled with the name agents get; `short` shows the server's own tool name. */
export function McpToolBadge({ slug, tool, short }: { slug: string; tool: string; short?: boolean }) {
  return (
    <Badge variant="outline" className="max-w-full bg-background font-mono font-normal" title={mcpToolName(slug, tool)}>
      <span className="truncate">{short ? tool : mcpToolName(slug, tool)}</span>
    </Badge>
  );
}

const SUCCESS_TEXT = "text-[color-mix(in_oklch,var(--success),black_15%)] dark:text-success";

/** Outcome of a connection test. `compact`: list cards, short tool names and at most eight of them. */
export function McpTestResultView({ result, slug, compact }: { result: McpTestResult; slug: string; compact?: boolean }) {
  const t = useTranslations("mcp.testResult");
  const ok = result.ok;
  const shown = ok ? (compact ? result.tools.slice(0, 8) : result.tools) : [];
  const Icon = ok ? CircleCheckIcon : CircleXIcon;

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border",
        ok ? "border-success/25 bg-success/5" : "border-destructive/25 bg-destructive/5",
        compact ? "p-2.5" : "p-3",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {!compact && (
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg",
              ok ? cn("bg-success/12", SUCCESS_TEXT) : "bg-destructive/10 text-destructive",
            )}
          >
            <Icon className="size-4" aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className={cn("flex items-center gap-1.5 text-sm font-medium", ok ? SUCCESS_TEXT : "text-destructive")}>
            {compact && <Icon className="size-3.5 shrink-0" aria-hidden />}
            {ok ? t("connected", { count: result.tools.length }) : t("failed")}
          </p>
          <p className="text-xs text-muted-foreground wrap-anywhere">
            {ok ? (
              <span className="tabular">{t("duration", { ms: result.durationMs })}</span>
            ) : (
              (result.error ?? t("unknownError"))
            )}
          </p>
        </div>
      </div>
      {shown.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {shown.map((tool) => (
            <McpToolBadge key={tool} slug={slug} tool={tool} short={compact} />
          ))}
          {ok && result.tools.length > shown.length && (
            <Badge variant="secondary">+{result.tools.length - shown.length}</Badge>
          )}
        </div>
      )}
    </div>
  );
}
