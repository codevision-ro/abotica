"use client";

import { MEMORY_MAX_LENGTH } from "@abotica/core/limits";
import { BrainIcon, PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { SectionCard } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { createMemory, type MemoryOwner } from "@/server/actions/memory";
import { type MemoryListItem, MemoryList } from "./memory-list";

/** The memory tab of an agent or a project: add an entry, review and edit the owner's entries. */
export function OwnedMemories({ owner, memories }: { owner: MemoryOwner; memories: MemoryListItem[] }) {
  const t = useTranslations("memory.owned");
  const tc = useTranslations("common.actions");
  const kind = "agentId" in owner ? "agent" : "project";
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const pendingCount = memories.filter((m) => m.status === "pending").length;

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
    <SectionCard icon={BrainIcon} title={t(`${kind}.title`)} count={memories.length} description={t(`${kind}.description`)}>
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

        {pendingCount > 0 && (
          <p className="text-sm text-muted-foreground">
            {t.rich("pendingNotice", {
              count: pendingCount,
              b: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
            })}
          </p>
        )}

        {memories.length ? (
          <MemoryList items={memories} owner={owner} />
        ) : (
          <p className="text-sm text-muted-foreground">{t(`${kind}.empty`)}</p>
        )}
      </div>
    </SectionCard>
  );
}
