"use client";

import { splitUntrusted } from "@abotica/core/agents/untrusted";
import { ChevronRight, Import } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment } from "react";
import { SectionDivider } from "@/components/app/section-card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/** Message key under `chat.untrusted.source` for each source the core wraps; MCP sources carry the server. */
const SOURCE_KEYS = {
  webhook: "webhook",
  "task-output": "taskOutput",
  "delegated-task": "delegatedTask",
  web: "web",
  knowledge: "knowledge",
  "pull-request": "pullRequest",
} as const;

function useSourceLabel(source: string): string {
  const t = useTranslations("chat.untrusted.source");
  if (source.startsWith("mcp:")) return t("mcp", { server: source.slice(4) });
  return source in SOURCE_KEYS ? t(SOURCE_KEYS[source as keyof typeof SOURCE_KEYS]) : source;
}

/** Data from outside (a webhook payload, a task's output), closed by default and labelled by where it came from. */
function UntrustedBlock({ source, text }: { source: string; text: string }) {
  const t = useTranslations("chat.untrusted");
  const label = useSourceLabel(source);
  return (
    <Collapsible className="group/untrusted my-1.5 w-full overflow-hidden rounded-lg border border-border/70 bg-background/70 text-left dark:bg-background/40">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-xs transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset">
        <Import className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{t("label")}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/untrusted:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SectionDivider />
        <pre className="max-h-72 overflow-auto px-2.5 py-2 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A message's text with the untrusted-data blocks the core put in it (a trigger's payload) shown as
 * external data instead of raw tags. A block starts its own line, so the line breaks around it go.
 */
export function UntrustedText({ text }: { text: string }) {
  const segments = splitUntrusted(text);
  return segments.map((segment, i) => {
    if (segment.type === "untrusted") return <UntrustedBlock key={i} source={segment.source} text={segment.text} />;
    let plain = segment.text;
    if (segments[i - 1]?.type === "untrusted") plain = plain.replace(/^\n/, "");
    if (segments[i + 1]?.type === "untrusted") plain = plain.replace(/\n$/, "");
    return <Fragment key={i}>{plain}</Fragment>;
  });
}
