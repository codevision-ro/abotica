"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { MEMORY_MAX_LENGTH } from "@abotica/core/limits";
import { Check, FolderKanban, Globe, History, Pencil, Pin, PinOff, Undo2, UserRound, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { ConfirmDelete } from "@/components/app/confirm-dialog";
import { RelativeTime } from "@/components/app/relative-time";
import { SectionIcon } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";
import {
  approveMemories,
  deleteMemory,
  type MemoryOwner,
  rejectMemories,
  restoreMemory,
  setMemoryPinned,
  updateMemory,
} from "@/server/actions/memory";
import { FlagReason, OriginBadge, PendingBadge, RetentionBadge, ScopeBadge, SourceBadge } from "./memory-badges";

export type MemoryListItem = {
  id: string;
  content: string;
  source: string;
  /** Whose content it is (owner, agent, untrusted, system); absent where a list does not load it. */
  origin?: string;
  status: string;
  /** In every run of its scope (within the pinned budget); absent where a list does not load it. */
  pinned?: boolean;
  /** Why the write waits for approval (see memory-scan.ts), shown in the approval queue. */
  flagReason?: string | null;
  updatedAt: Date;
  /** The fields below are shown on the memory page, where entries of every owner are mixed. */
  scope?: string;
  /** A project entry's project; for an agent entry, the project of its note (null: the agent's global memory). */
  projectId?: string | null;
  projectName?: string | null;
  agentId?: string | null;
  /** The owner of an agent entry; the author of a project entry (null when the user wrote it). */
  agentName?: string | null;
  agentAvatar?: AgentAvatarValue | null;
  similarity?: number | null;
  /** How long the fact holds, and since when (YYYY-MM-DD; null: since it was written). Absent where a list does not load it. */
  retention?: string;
  validFrom?: string | null;
  /** When an ephemeral entry stops being read. */
  expiresAt?: Date | null;
  /** Set when a newer entry replaced this one: history, which agents no longer read. */
  invalidatedAt?: Date | null;
  supersededBy?: string | null;
  /** How often runs used the entry. */
  recallCount?: number;
  /** For a pending entry: the current ones it replaces once approved. */
  replaces?: string[];
};

/** Anchor of an entry in a list, for the links from the entries it replaced. */
const rowId = (id: string) => `memory-${id}`;

/** A YYYY-MM-DD day is a calendar day, not an instant: read it in local time so it shows as written. */
const asDate = (value: Date | string) => (typeof value === "string" ? new Date(`${value}T00:00:00`) : value);

/**
 * Since when the fact holds and until when, or when a newer entry replaced it (with a link to that entry
 * when it is in the list).
 */
function Validity({ m }: { m: MemoryListItem }) {
  const t = useTranslations("memory.list");
  const f = useFormat();
  const day = (value: Date | string) => f.date(asDate(value), "d MMM yyyy");
  if (m.invalidatedAt) {
    return (
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground/80">
        <History aria-hidden className="size-3" />
        {t("invalidatedAt", { date: day(m.invalidatedAt) })}
        {m.supersededBy && (
          <a href={`#${rowId(m.supersededBy)}`} className="font-normal underline underline-offset-2 hover:text-primary">
            {t("replacedBy")}
          </a>
        )}
      </span>
    );
  }
  const expiresAt = m.expiresAt ? new Date(m.expiresAt) : null;
  return (
    <>
      {m.validFrom && <span className="tabular">{t("validFrom", { date: day(m.validFrom) })}</span>}
      {expiresAt && (
        <span className={cn("tabular", expiresAt <= new Date() && "text-warning")} suppressHydrationWarning>
          {expiresAt <= new Date() ? t("expired", { date: day(expiresAt) }) : t("expiresAt", { date: day(expiresAt) })}
        </span>
      )}
    </>
  );
}

/** Row actions stay visible on touch screens and appear on hover or focus where a pointer can hover. */
export const rowActionsClass =
  "flex shrink-0 items-center gap-1 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-focus-within/row:opacity-100";

/** Avatar of the entry's owner: the agent's icon, a folder for a project, a globe for everyone. */
export function MemoryOwnerMedia({ m }: { m: MemoryListItem }) {
  if (m.scope === "agent") return <AgentAvatar avatar={m.agentAvatar} size="lg" />;
  return <SectionIcon icon={m.scope === "project" ? FolderKanban : Globe} />;
}

function ownerName(m: MemoryListItem, t: ReturnType<typeof useTranslations<"memory.list">>) {
  if (m.scope === "project") return m.projectName ?? t("deletedProject");
  if (m.scope === "agent") {
    const agent = m.agentName ?? t("deletedAgent");
    // An agent's note on a project: the project says where it holds.
    return m.projectId ? `${agent} · ${m.projectName ?? t("deletedProject")}` : agent;
  }
  return t("allAgents");
}

/**
 * Who wrote a project entry: the agent, or "You" for the user's own. Null when unknown (e.g. a
 * consolidated entry), where the source badge says where it came from.
 */
function ProjectAuthor({ m }: { m: MemoryListItem }) {
  const t = useTranslations("memory.list");
  if (m.scope !== "project") return null;
  if (m.agentName) {
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1.5 text-foreground/80"
        title={t("writtenBy", { name: m.agentName })}
      >
        <AgentAvatar avatar={m.agentAvatar} size="xs" />
        <span className="truncate">{m.agentName}</span>
      </span>
    );
  }
  if (m.source !== "manual") return null;
  return (
    <span className="inline-flex items-center gap-1 text-foreground/80" title={t("writtenByYou")}>
      <UserRound className="size-3.5" aria-hidden />
      {t("you")}
    </span>
  );
}

const hasAuthor = (m: MemoryListItem) => m.scope === "project" && (!!m.agentName || m.source === "manual");

/** Owner, author, badges and time under an entry; shared with the pending list. */
export function MemoryMeta({
  m,
  showScope = false,
  showOwner = false,
  showStatus = true,
}: {
  m: MemoryListItem;
  showScope?: boolean;
  showOwner?: boolean;
  showStatus?: boolean;
}) {
  const t = useTranslations("memory.list");
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {showOwner && m.scope && (
        <span className="max-w-full truncate font-medium text-foreground/80">{ownerName(m, t)}</span>
      )}
      {showScope && m.scope && <ScopeBadge scope={m.scope} />}
      <ProjectAuthor m={m} />
      {showStatus && m.status === "pending" && <PendingBadge />}
      {m.pinned && (
        <span className="inline-flex items-center gap-1 font-medium text-primary">
          <Pin aria-hidden className="size-3" />
          {t("pinned")}
        </span>
      )}
      {/* A named author already says where the entry came from. */}
      {!hasAuthor(m) && <SourceBadge source={m.source} />}
      {m.origin && <OriginBadge origin={m.origin} />}
      {m.retention && <RetentionBadge retention={m.retention} />}
      <Validity m={m} />
      <RelativeTime date={m.updatedAt} />
      {m.recallCount !== undefined && m.status !== "pending" && (
        <span className="tabular" title={t("recallsHint")}>
          {t("recalls", { count: m.recallCount })}
        </span>
      )}
      {m.similarity != null && (
        <span className="tabular">{t("similarity", { percent: Math.round(m.similarity * 100) })}</span>
      )}
    </div>
  );
}

/** For a pending entry: the entries it replaces once approved. */
export function Replaces({ m }: { m: MemoryListItem }) {
  const t = useTranslations("memory.pending");
  if (m.status !== "pending" || !m.replaces?.length) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {m.replaces.map((content, i) => (
        <li key={i} className="wrap-anywhere">
          {t("replaces", { content })}
        </li>
      ))}
    </ul>
  );
}

/** Focus the editor once on mount with the caret after the existing text. */
function focusAtEnd(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

function MemoryItem({
  memory,
  owner,
  showScope,
  showOwner,
}: {
  memory: MemoryListItem;
  owner?: MemoryOwner;
  showScope: boolean;
  showOwner: boolean;
}) {
  const t = useTranslations("memory.list");
  const tc = useTranslations("common.actions");
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [pending, startTransition] = useTransition();
  const isPending = memory.status === "pending";
  const replaced = !!memory.invalidatedAt;
  const canSave = !pending && !!content.trim() && content !== memory.content;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string, after?: () => void) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) return void toast.error(res.error);
      toast.success(success);
      after?.();
    });
  }

  function startEdit() {
    setContent(memory.content);
    setEditing(true);
  }

  function save() {
    if (!canSave) return;
    run(
      () => updateMemory({ id: memory.id, content, owner }),
      t("updated"),
      () => setEditing(false),
    );
  }

  return (
    <li
      id={rowId(memory.id)}
      className={cn(
        "group/row flex min-w-0 scroll-mt-20 items-center gap-3 px-4 py-3 transition-colors target:bg-primary/5 sm:px-5",
        isPending ? "bg-warning/5" : "hover:bg-muted/30",
        replaced && "bg-muted/20",
        editing && "items-start bg-muted/30",
      )}
    >
      {showOwner && <MemoryOwnerMedia m={memory} />}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              aria-label={t("content")}
              value={content}
              maxLength={MEMORY_MAX_LENGTH}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
              }}
              rows={3}
              className="max-h-[50dvh] bg-background"
              ref={focusAtEnd}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {tc("cancel")}
              </Button>
              <Button size="sm" disabled={!canSave} onClick={save}>
                {pending && <Spinner />} {tc("save")}
              </Button>
            </div>
          </div>
        ) : (
          <p
            className={cn(
              "text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere",
              replaced && "text-muted-foreground line-through decoration-muted-foreground/40",
            )}
          >
            {memory.content}
          </p>
        )}
        {isPending && memory.flagReason && <FlagReason reason={memory.flagReason} />}
        <Replaces m={memory} />
        <MemoryMeta m={memory} showScope={showScope} showOwner={showOwner} />
      </div>
      {!editing && (
        <div className={cn(rowActionsClass, isPending && "opacity-100!")}>
          {isPending && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => run(() => approveMemories({ ids: [memory.id], owner }), t("approved"))}
              >
                {pending ? <Spinner /> : <Check className="text-success" />} {tc("approve")}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={tc("reject")}
                title={tc("reject")}
                disabled={pending}
                onClick={() => run(() => rejectMemories({ ids: [memory.id], owner }), t("rejected"))}
                className="hover:text-destructive"
              >
                <X />
              </Button>
            </>
          )}
          {replaced && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => restoreMemory({ id: memory.id, owner }), t("restored"))}
            >
              {pending ? <Spinner /> : <Undo2 />} {t("restore")}
            </Button>
          )}
          {!isPending && !replaced && memory.pinned !== undefined && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={memory.pinned ? t("unpin") : t("pin")}
              title={memory.pinned ? t("unpin") : t("pin")}
              disabled={pending}
              onClick={() =>
                run(
                  () => setMemoryPinned({ id: memory.id, pinned: !memory.pinned, owner }),
                  memory.pinned ? t("unpinnedToast") : t("pinnedToast"),
                )
              }
            >
              {memory.pinned ? <PinOff /> : <Pin />}
            </Button>
          )}
          {/* History stays as it was written. */}
          {!replaced && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("edit")}
              title={t("edit")}
              disabled={pending}
              onClick={startEdit}
            >
              <Pencil />
            </Button>
          )}
          {!isPending && (
            <ConfirmDelete
              label={t("delete")}
              title={t("deleteTitle")}
              description={t("deleteDescription")}
              onConfirm={async () => {
                const res = await deleteMemory({ id: memory.id, owner });
                if (res.ok) toast.success(t("deleted"));
                else toast.error(res.error);
              }}
            />
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Memory entries with inline edit, delete, and approve/reject for pending ones. On an agent's or
 * a project's page pass `owner`: writes are then limited to that owner and the owner avatar is hidden.
 * `flush` drops the outer border, for lists that sit directly in a card.
 */
export function MemoryList({
  items,
  owner,
  showScope = false,
  flush = false,
}: {
  items: MemoryListItem[];
  owner?: MemoryOwner;
  showScope?: boolean;
  flush?: boolean;
}) {
  return (
    <ul
      className={cn(
        "divide-y divide-border/60",
        !flush && "overflow-hidden rounded-xl border border-border/70 bg-card/50 dark:bg-transparent",
      )}
    >
      {items.map((m) => (
        <MemoryItem
          key={m.id}
          memory={m}
          owner={owner}
          showScope={showScope}
          // A global entry belongs to everyone: its owner only matters next to entries of other levels.
          showOwner={!owner && !!m.scope && (showScope || m.scope !== "global")}
        />
      ))}
    </ul>
  );
}
