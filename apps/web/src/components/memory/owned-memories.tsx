"use client";

import { MEMORY_MAX_LENGTH } from "@abotica/core/limits";
import { BrainIcon, History, PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { SectionCard } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { createMemory, type MemoryOwner } from "@/server/actions/memory";
import { type MemoryListItem, MemoryList } from "./memory-list";
import { PinnedBudget, type PinnedUsage } from "./pinned-budget";

/**
 * The memory tab of an agent or a project: add an entry, review, edit and pin the owner's entries, see
 * how much of the pinned budget its runs use, and the entries newer ones replaced (history) on demand.
 */
export function OwnedMemories({
  owner,
  memories,
  pinnedUsage,
}: {
  owner: MemoryOwner;
  memories: MemoryListItem[];
  pinnedUsage: PinnedUsage;
}) {
  const t = useTranslations("memory.owned");
  const tc = useTranslations("common.actions");
  const kind = "agentId" in owner ? "agent" : "project";
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const tf = useTranslations("memory.filters");
  const [showHistory, setShowHistory] = useState(false);
  const pendingCount = memories.filter((m) => m.status === "pending").length;
  const replacedCount = memories.filter((m) => m.invalidatedAt).length;
  const shown = showHistory ? memories : memories.filter((m) => !m.invalidatedAt);

  function add(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || pending) return;
    startTransition(async () => {
      const res = await createMemory(
        "agentId" in owner
          ? { scope: "agent", agentId: owner.agentId, content: draft }
          : { scope: "project", projectId: owner.projectId, content: draft },
      );
      if (!res.ok) return void toast.error(res.error);
      setDraft("");
      toast.success(t("added"));
    });
  }

  return (
    <SectionCard
      icon={BrainIcon}
      title={t(`${kind}.title`)}
      count={memories.length - replacedCount}
      description={t(`${kind}.description`)}
    >
      <div className="flex flex-col gap-4">
        <form onSubmit={add} className="flex flex-col gap-2">
          <label htmlFor="memory-new" className="sr-only">
            {t("addLabel")}
          </label>
          <Textarea
            id="memory-new"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t(`${kind}.placeholder`)}
            maxLength={MEMORY_MAX_LENGTH}
            rows={3}
            className="max-h-[50dvh]"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add(e);
            }}
          />
          <div className="flex justify-end">
            {/* Secondary: the page header already holds the primary action (Chat). */}
            <Button type="submit" variant="outline" disabled={pending || !draft.trim()}>
              {pending ? <Spinner /> : <PlusIcon />}
              {tc("add")}
            </Button>
          </div>
        </form>

        <PinnedBudget usage={pinnedUsage} withGlobal />

        {pendingCount > 0 && (
          <p className="text-sm text-muted-foreground">
            {t.rich("pendingNotice", {
              count: pendingCount,
              b: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
            })}
          </p>
        )}

        {replacedCount > 0 && (
          <Toggle
            variant="outline"
            size="sm"
            pressed={showHistory}
            onPressedChange={setShowHistory}
            className="w-fit bg-background font-normal data-[state=on]:border-primary/40 data-[state=on]:bg-primary/5 dark:bg-input/30 dark:data-[state=on]:bg-primary/10 [&_svg]:text-muted-foreground"
          >
            <History /> {tf("history")} <span className="text-muted-foreground tabular">{replacedCount}</span>
          </Toggle>
        )}

        {shown.length ? (
          <MemoryList items={shown} owner={owner} />
        ) : (
          <p className="text-sm text-muted-foreground">{t(`${kind}.empty`)}</p>
        )}
      </div>
    </SectionCard>
  );
}
