"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { MEMORY_MAX_LENGTH } from "@abotica/core/limits";
import { BrainIcon, FolderKanban, Globe, History, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { FormSubsection } from "@/components/app/form-section";
import { SectionCard } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { createMemory, type MemoryOwner } from "@/server/actions/memory";
import { type MemoryListItem, MemoryList } from "./memory-list";
import { PinnedBudget, type PinnedUsage } from "./pinned-budget";

/** The add form's choice that writes the agent's global memory instead of a note on one project. */
const ALL_PROJECTS = "__all";

type NoteGroup = {
  id: string;
  name: string;
  avatar?: AgentAvatarValue | null;
  items: MemoryListItem[];
};

/** Notes by the project they hold in (on an agent) or by the agent that keeps them (on a project), by name. */
function groupNotes(notes: MemoryListItem[], by: "project" | "agent", fallback: string): NoteGroup[] {
  const groups = new Map<string, NoteGroup>();
  for (const m of notes) {
    const id = (by === "project" ? m.projectId : m.agentId) ?? "";
    const group = groups.get(id) ?? {
      id,
      name: (by === "project" ? m.projectName : m.agentName) ?? fallback,
      avatar: by === "agent" ? m.agentAvatar : undefined,
      items: [],
    };
    group.items.push(m);
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The memory tab of an agent or a project: add an entry, review, edit and pin the entries, see how much
 * of the pinned budget its runs use, and the entries newer ones replaced (history) on demand. On an
 * agent: its global memory, then its notes per project. On a project: the team memory, then each
 * agent's notes on it. `projects` (on an agent) lets a new entry be the agent's note on one of them.
 */
export function OwnedMemories({
  owner,
  memories,
  pinnedUsage,
  projects,
}: {
  owner: MemoryOwner;
  memories: MemoryListItem[];
  pinnedUsage: PinnedUsage;
  projects?: { id: string; name: string }[];
}) {
  const t = useTranslations("memory.owned");
  const tc = useTranslations("common.actions");
  const tl = useTranslations("memory.list");
  const kind = "agentId" in owner ? "agent" : "project";
  const [draft, setDraft] = useState("");
  const [noteProject, setNoteProject] = useState(ALL_PROJECTS);
  const [pending, startTransition] = useTransition();
  const tf = useTranslations("memory.filters");
  const [showHistory, setShowHistory] = useState(false);
  const pendingCount = memories.filter((m) => m.status === "pending").length;
  const replacedCount = memories.filter((m) => m.invalidatedAt).length;
  const shown = showHistory ? memories : memories.filter((m) => !m.invalidatedAt);
  // An agent's own: its global memory; a project's own: the team memory. The rest are agents' project notes.
  const isNote = (m: MemoryListItem) => (kind === "agent" ? !!m.projectId : m.scope === "agent");
  const own = shown.filter((m) => !isNote(m));
  const notes = shown.filter(isNote);
  const groups = groupNotes(
    notes,
    kind === "agent" ? "project" : "agent",
    kind === "agent" ? tl("deletedProject") : tl("deletedAgent"),
  );
  const noteChoices = kind === "agent" ? (projects ?? []) : [];

  function add(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || pending) return;
    startTransition(async () => {
      const res = await createMemory(
        "agentId" in owner
          ? {
              scope: "agent",
              agentId: owner.agentId,
              projectId: noteProject === ALL_PROJECTS ? null : noteProject,
              content: draft,
            }
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
      <div className="flex flex-col gap-5">
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
          <div className="flex flex-wrap items-center justify-end gap-2">
            {noteChoices.length > 0 && (
              <Select value={noteProject} onValueChange={setNoteProject}>
                <SelectTrigger
                  aria-label={t("agent.target")}
                  className="w-full bg-background sm:w-56 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-w-[calc(100vw-2rem)]">
                  <SelectItem value={ALL_PROJECTS} className="*:[span]:last:min-w-0">
                    <Globe className="text-muted-foreground" />
                    <span className="truncate">{t("agent.targetGlobal")}</span>
                  </SelectItem>
                  {noteChoices.map((p) => (
                    <SelectItem key={p.id} value={p.id} className="*:[span]:last:min-w-0">
                      <FolderKanban className="text-muted-foreground" />
                      <span className="truncate">{p.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
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

        <FormSubsection title={t(`${kind}.ownTitle`)} count={own.length} description={t(`${kind}.ownDescription`)}>
          {own.length ? (
            <MemoryList items={own} owner={owner} />
          ) : (
            <p className="text-sm text-muted-foreground">{t(`${kind}.empty`)}</p>
          )}
        </FormSubsection>

        {groups.length > 0 && (
          <FormSubsection title={t(`${kind}.notesTitle`)} count={notes.length} description={t(`${kind}.notesDescription`)}>
            <div className="flex flex-col gap-4">
              {groups.map((g) => (
                <div key={g.id} className="flex min-w-0 flex-col gap-1.5">
                  <h4 className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
                    {kind === "agent" ? (
                      <FolderKanban className="size-3.5 shrink-0" aria-hidden />
                    ) : (
                      <AgentAvatar avatar={g.avatar} size="xs" />
                    )}
                    {g.id ? (
                      <Link
                        href={kind === "agent" ? `/projects/${g.id}?tab=memory` : `/agents/${g.id}?tab=memory`}
                        className="truncate text-foreground/80 underline-offset-2 hover:text-primary hover:underline"
                      >
                        {g.name}
                      </Link>
                    ) : (
                      <span className="truncate text-foreground/80">{g.name}</span>
                    )}
                    <span className="tabular">{g.items.length}</span>
                  </h4>
                  <MemoryList items={g.items} owner={owner} />
                </div>
              ))}
            </div>
          </FormSubsection>
        )}
      </div>
    </SectionCard>
  );
}
