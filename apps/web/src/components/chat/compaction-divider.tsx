"use client";

import type { CompactionMetadata } from "@abotica/core/compaction-record";
import { ChevronRight, FoldVertical } from "lucide-react";
import { useTranslations } from "next-intl";
import { SectionDivider } from "@/components/app/section-card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChatMarkdown, MessageTime } from "./chat-parts";

/**
 * Where the conversation was compacted: from here on the agent gets the summary instead of the messages
 * above, which stay in the chat. Opens to show the summary.
 */
export function CompactionDivider({ compaction, date }: { compaction: CompactionMetadata; date: string | undefined }) {
  const t = useTranslations("chat.compaction");
  return (
    <Collapsible className="group/compaction w-full shrink-0">
      <div className="flex items-center gap-3">
        <div aria-hidden className="h-px flex-1 bg-linear-to-r from-transparent to-border" />
        <CollapsibleTrigger
          title={t("show")}
          className="flex max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-card/70 px-3 py-1 text-xs text-muted-foreground transition-colors outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-card/40"
        >
          <FoldVertical className="size-3.5 shrink-0" />
          <span className="truncate">{t("marker")}</span>
          <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/compaction:rotate-90" />
        </CollapsibleTrigger>
        <div aria-hidden className="h-px flex-1 bg-linear-to-l from-transparent to-border" />
      </div>
      <CollapsibleContent>
        <div className="mx-auto mt-3 w-full max-w-xl overflow-hidden rounded-xl border border-border/70 bg-card/70 shadow-[0_1px_2px_rgb(0_0_0/0.03)] dark:bg-card/40">
          <div className="flex items-center gap-2.5 px-3 py-2.5 text-[11px] text-muted-foreground/80">
            <span className="min-w-0 flex-1 truncate">{t("hint")}</span>
            <span className="shrink-0">
              <MessageTime date={date} />
            </span>
          </div>
          <SectionDivider />
          <ChatMarkdown className="px-3 py-2.5 text-sm">{compaction.summary}</ChatMarkdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
