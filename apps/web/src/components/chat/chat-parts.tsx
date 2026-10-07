"use client";

import { TOOL_CATALOG } from "@abotica/core/agents/tools/tool-catalog";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { isToday } from "date-fns";
import { Ban, Check, ChevronRight, CircleX, Clock3, type LucideIcon, Plug, ShieldAlert, Wrench, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { TOOL_GROUP_ICONS } from "@/components/app/tool-group-icons";
import { JsonBlock } from "@/components/runs/json-block";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";

type ToolPart = ToolUIPart | DynamicToolUIPart;

/** Shared width for the message column and the composer, so their edges line up. */
export const CHAT_COLUMN = "mx-auto w-full max-w-4xl px-4 md:px-8 min-[1600px]:max-w-5xl";

/**
 * Tool label in the current language (`tools.<name>.label`) with its group's icon, or the MCP tool
 * name and its server.
 */
function useToolInfo(name: string): { label: string; server: string | null; icon: LucideIcon } {
  const t = useTranslations();
  const builtin = TOOL_CATALOG.find((tool) => tool.name === name);
  if (builtin) {
    const key = `tools.${name}.label` as Parameters<typeof t>[0];
    return { label: t.has(key) ? t(key) : name, server: null, icon: TOOL_GROUP_ICONS[builtin.group] };
  }
  if (name === "skill_read") return { label: t("chat.tool.skillRead"), server: null, icon: Wrench };
  if (name === "tool_search") return { label: t("chat.tool.toolSearch"), server: null, icon: Wrench };
  const sep = name.indexOf("__");
  if (sep > 0) return { label: name.slice(sep + 2), server: name.slice(0, sep), icon: Plug };
  return { label: name, server: null, icon: Wrench };
}

const WARNING_TEXT = "text-[color-mix(in_oklch,var(--warning),black_35%)] dark:text-warning";

type StateKey =
  "inputStreaming" | "inputAvailable" | "approvalRequested" | "approvalResponded" | "outputError" | "outputDenied";

/** `label` is a key under `chat.tool.states`; a finished call shows no label. */
const STATE: Record<ToolPart["state"], { label: StateKey | null; icon: React.ReactNode }> = {
  "input-streaming": { label: "inputStreaming", icon: <Spinner className="size-3.5 text-muted-foreground" /> },
  "input-available": { label: "inputAvailable", icon: <Spinner className="size-3.5 text-primary" /> },
  "approval-requested": { label: "approvalRequested", icon: <ShieldAlert className={cn("size-3.5", WARNING_TEXT)} /> },
  "approval-responded": { label: "approvalResponded", icon: <Clock3 className="size-3.5 text-muted-foreground" /> },
  "output-available": { label: null, icon: <Check className="size-3.5 text-success" /> },
  "output-error": { label: "outputError", icon: <CircleX className="size-3.5 text-destructive" /> },
  "output-denied": { label: "outputDenied", icon: <Ban className="size-3.5 text-muted-foreground" /> },
};

/** The quiet card consecutive tool calls are stacked in, one row each. */
export function ChatToolGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full min-w-0 shrink-0 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card/70 shadow-[0_1px_2px_rgb(0_0_0/0.03)] dark:bg-card/40">
      {children}
    </div>
  );
}

/** One tool call as a row of `ChatToolGroup`; expands to show parameters and result. */
export function ChatToolCall({ part, name, children }: { part: ToolPart; name: string; children?: React.ReactNode }) {
  const t = useTranslations("chat.tool");
  const tool = useToolInfo(name);
  const state = STATE[part.state];
  const hasOutput = part.state === "output-available" || part.state === "output-error";

  return (
    <Collapsible
      defaultOpen={part.state === "approval-requested" || part.state === "output-error"}
      className="group/tool flex w-full min-w-0 flex-col"
    >
      <CollapsibleTrigger
        className={cn(
          "flex min-h-10 w-full min-w-0 items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-muted/40",
          "focus-visible:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset",
        )}
        title={tool.server ? `${tool.label} (${tool.server})` : tool.label}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <tool.icon className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="min-w-0 truncate font-medium">{tool.label}</span>
          {tool.server && (
            <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">{tool.server}</span>
          )}
        </span>
        {state.label && (
          <span
            className={cn(
              "shrink-0 text-xs text-muted-foreground",
              part.state === "output-error" && "text-destructive",
              part.state === "approval-requested" && WARNING_TEXT,
            )}
          >
            {t(`states.${state.label}`)}
          </span>
        )}
        {state.icon}
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="w-full">
        <div className="space-y-3 px-3 pt-1 pb-3">
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">{t("parameters")}</div>
            <JsonBlock value={part.input ?? {}} className="max-h-64 bg-muted/50" />
          </div>
          {hasOutput && (
            <div className="space-y-1.5">
              <div className={cn("text-xs font-medium text-muted-foreground", part.errorText && "text-destructive")}>
                {part.errorText ? t("error") : t("result")}
              </div>
              {part.errorText ? (
                <pre className="max-h-64 overflow-auto rounded-lg border border-destructive/30 bg-destructive/5 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-destructive">
                  {part.errorText}
                </pre>
              ) : (
                <JsonBlock value={part.output} className="max-h-64 bg-muted/50" />
              )}
            </div>
          )}
        </div>
      </CollapsibleContent>
      {children}
    </Collapsible>
  );
}

/** Approval request for a tool call, mirroring the ai-elements Confirmation states; sits inside the call's row. */
export function ChatApproval({
  part,
  name,
  onDecide,
}: {
  part: ToolPart;
  name: string;
  onDecide: (approvalId: string, approved: boolean) => Promise<void>;
}) {
  const [pending, setPending] = useState<boolean | null>(null);
  const t = useTranslations("chat.approval");
  const tCommon = useTranslations("common");
  const tool = useToolInfo(name);
  const approval = part.approval;
  if (!approval) return null;

  if (part.state === "approval-requested") {
    const decide = async (approved: boolean) => {
      setPending(approved);
      try {
        await onDecide(approval.id, approved);
      } finally {
        setPending(null);
      }
    };
    return (
      <div className="mx-3 mb-3 rounded-lg border border-warning/40 bg-warning/5 p-3">
        <div className="flex items-center gap-3">
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning/15", WARNING_TEXT)}>
            <ShieldAlert className="size-4" />
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="text-sm font-medium">{t("title")}</div>
            <p className="text-sm text-muted-foreground wrap-anywhere">
              {t.rich(tool.server ? "descriptionWithServer" : "description", {
                tool: tool.label,
                server: tool.server ?? "",
                b: (chunks) => <strong className="font-medium text-foreground">{chunks}</strong>,
              })}
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => decide(false)}>
            {pending === false ? <Spinner /> : <X />}
            {tCommon("actions.reject")}
          </Button>
          <Button size="sm" disabled={pending !== null} onClick={() => decide(true)}>
            {pending === true ? <Spinner /> : <Check />}
            {tCommon("actions.approve")}
          </Button>
        </div>
      </div>
    );
  }

  if (approval.approved === undefined) return null;
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-3 pb-2.5 pl-11.5 text-xs font-medium",
        approval.approved ? "text-success" : "text-destructive",
      )}
    >
      {approval.approved ? <Check className="size-3.5" /> : <X className="size-3.5" />}
      {approval.approved ? t("approved") : t("rejected")}
    </div>
  );
}

const PROSE = cn(
  "text-[15px] leading-7 wrap-anywhere",
  "[&_strong]:font-semibold",
  "[&_h1]:mt-8 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:tracking-tight",
  "[&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight",
  "[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold",
  "[&_h4]:mt-5 [&_h4]:mb-2 [&_h4]:text-[15px] [&_h4]:font-semibold",
  "[&_ol]:list-outside [&_ol]:pl-6 [&_ul]:list-outside [&_ul]:pl-6 [&_li]:py-0.5 [&_li]:pl-1",
  "[&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground",
  "[&_hr]:my-6 [&_hr]:border-border",
  "[&_[data-streamdown=inline-code]]:text-[13px] [&_[data-streamdown=inline-code]]:wrap-anywhere",
  "[&_[data-streamdown=code-block]]:my-5 [&_[data-streamdown=table-wrapper]]:my-5",
  "[&_[data-streamdown=code-block]]:gap-1.5 [&_[data-streamdown=code-block]]:border-border/70 [&_[data-streamdown=code-block]]:bg-muted/40 [&_[data-streamdown=code-block]]:p-1.5",
  "[&_[data-streamdown=code-block-header]]:pl-1.5 [&_[data-streamdown=code-block-body]]:rounded-lg [&_[data-streamdown=code-block-body]]:border-border/60 [&_[data-streamdown=code-block-body]]:bg-card dark:[&_[data-streamdown=code-block-body]]:bg-background",
  "[&_[data-streamdown=table-wrapper]]:rounded-xl [&_[data-streamdown=table-wrapper]]:border-border/70 [&_[data-streamdown=table-wrapper]]:bg-muted/40 [&_[data-streamdown=table-wrapper]]:p-1.5",
  "[&_[data-streamdown=code-block-body]]:max-h-[32rem] [&_[data-streamdown=code-block-body]_pre]:text-[13px] [&_[data-streamdown=code-block-body]_pre]:leading-6",
  "[&_[data-streamdown=table-cell]]:align-top [&_[data-streamdown=table-cell]]:wrap-normal [&_[data-streamdown=table-cell]]:min-w-24",
);

/** Assistant markdown with chat typography (line-height, rhythm, scrollable code and tables). */
export function ChatMarkdown({ children, className }: { children: string; className?: string }) {
  return <MessageResponse className={cn(PROSE, className)}>{children}</MessageResponse>;
}

export function MessageTime({ date }: { date: string | undefined }) {
  const f = useFormat();
  if (!date) return null;
  const d = new Date(date);
  return (
    <time dateTime={d.toISOString()} title={f.dateTime(d)} suppressHydrationWarning>
      {f.date(d, isToday(d) ? "HH:mm" : "d MMM, HH:mm")}
    </time>
  );
}
