"use client";

import type { OfficeAgent, OfficeInteraction, OfficeInteractionKind, OfficeState } from "@abotica/core/office";
import { UserIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { RelativeTime } from "@/components/app/relative-time";
import { cn } from "@/lib/utils";

/** Kinds that name whoever receives them, so they have a `feed.toYou` sentence. */
const TO_YOU_KINDS = [
  "delegated",
  "help",
  "question",
  "answer",
  "escalated",
  "instruction",
  "progress",
  "report",
  "handoff",
  "redirected",
] as const satisfies readonly OfficeInteractionKind[];
const namesReceiver = (kind: OfficeInteractionKind): kind is (typeof TO_YOU_KINDS)[number] =>
  (TO_YOU_KINDS as readonly string[]).includes(kind);

/** The sentence of one interaction, in the "you" form when the user is on either side. */
function useInteractionSentence(agents: OfficeAgent[]) {
  const t = useTranslations("office");
  const byId = new Map(agents.map((a) => [a.id, a]));
  return (i: OfficeInteraction) => {
    const you = t("places.you");
    const name = (id: string | null) => (id ? (byId.get(id)?.name ?? "?") : you);
    const args = { from: name(i.fromAgentId), to: name(i.toAgentId), task: i.task.title };
    if (!i.fromAgentId) return t(`feed.fromYou.${i.kind}`, args);
    if (!i.toAgentId && namesReceiver(i.kind)) return t(`feed.toYou.${i.kind}`, args);
    return t(`feed.${i.kind}`, args);
  };
}

/** The latest interactions, newest first. With `onSelect` each line is a button. */
export function OfficeFeed({
  state,
  selectedId,
  onSelect,
  className,
}: {
  state: Pick<OfficeState, "agents" | "interactions">;
  selectedId?: string | null;
  onSelect?: (interaction: OfficeInteraction) => void;
  className?: string;
}) {
  const t = useTranslations("office.feed");
  const sentence = useInteractionSentence(state.agents);
  const byId = new Map(state.agents.map((a) => [a.id, a]));

  if (!state.interactions.length) {
    return <p className={cn("px-4 py-4 text-sm text-muted-foreground", className)}>{t("empty")}</p>;
  }

  return (
    <ul className={cn("divide-y divide-border/60", className)}>
      {state.interactions.map((i) => {
        const from = i.fromAgentId ? byId.get(i.fromAgentId) : null;
        const body = (
          <>
            {from ? (
              <AgentAvatar avatar={from.avatar} size="sm" />
            ) : (
              <span
                aria-hidden
                className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
              >
                <UserIcon className="size-3.5" />
              </span>
            )}
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex min-w-0 items-baseline gap-2">
                <p className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug wrap-anywhere">{sentence(i)}</p>
                <RelativeTime date={i.at} className="shrink-0 text-xs text-muted-foreground" />
              </div>
              {i.text && (
                <p className="line-clamp-2 text-xs text-muted-foreground wrap-anywhere" title={i.text}>
                  {i.text}
                </p>
              )}
            </div>
          </>
        );
        const rowClass = "flex w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left";
        return (
          <li key={i.id}>
            {onSelect ? (
              <button
                type="button"
                aria-pressed={selectedId === i.id}
                onClick={() => onSelect(i)}
                className={cn(
                  rowClass,
                  "transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
                  selectedId === i.id && "bg-primary/6 dark:bg-primary/12",
                )}
              >
                {body}
              </button>
            ) : (
              <div className={rowClass}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
