"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { FolderKanbanIcon, GlobeIcon, ListIcon, MessagesSquareIcon, Send, SquarePenIcon, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createContext, use, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { RelativeTime } from "@/components/app/relative-time";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { deleteConversation } from "@/server/actions/chat";
import type { ChatAgent, ChatProject } from "@/server/queries/chat";
import { ALL, filterQuery, NO_PROJECT } from "@/lib/conversation-filter";
import { NewConversationDialog } from "./new-conversation-dialog";

type Conversation = {
  id: string;
  title: string;
  channel: "web" | "telegram" | "internal";
  updatedAt: Date;
  agentName: string;
  agentAvatar: AgentAvatarValue;
  /** Null for a conversation outside any project. */
  project: { id: string; name: string } | null;
};

type Props = {
  conversations: Conversation[];
  agents: ChatAgent[];
  projects: ChatProject[];
  /** Projects that have conversations: the filter's choices. */
  filterProjects: { id: string; name: string }[];
  /** The list's project filter from `?project=`: "all", "none" (outside projects) or a project id. */
  filter: string;
};

/** Where a list is shown: the mobile sheet needs room for its close button and closes on a pick. */
const PlacementContext = createContext<{ inSheet: boolean; close: () => void }>({ inSheet: false, close: () => {} });

/** Opens the conversation list on mobile, where it lives in a sheet; null outside the chat layout. */
const OpenListContext = createContext<(() => void) | null>(null);

/**
 * The chat frame: on desktop the conversation list (`list`, rendered by the chat's list slot) is a fixed
 * column next to the chat, on mobile it opens in a sheet from the chat header (`ConversationListTrigger`).
 */
export function ChatFrame({ list, children }: { list: React.ReactNode; children: React.ReactNode }) {
  const params = useParams<{ id?: string }>();
  const [open, setOpen] = useState(false);
  const t = useTranslations("chat.list");
  // Close the mobile sheet whenever another conversation opens (picked, created, or after a delete).
  const [shownId, setShownId] = useState(params.id);
  if (shownId !== params.id) {
    setShownId(params.id);
    setOpen(false);
  }

  return (
    <OpenListContext value={() => setOpen(true)}>
      <aside className="hidden w-72 shrink-0 flex-col overflow-hidden border-r border-border/70 bg-muted/30 md:flex dark:bg-muted/15">
        {list}
      </aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-[min(20rem,88vw)] gap-0 bg-sidebar p-0">
          <SheetTitle className="sr-only">{t("title")}</SheetTitle>
          <PlacementContext value={{ inSheet: true, close: () => setOpen(false) }}>{list}</PlacementContext>
        </SheetContent>
      </Sheet>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </OpenListContext>
  );
}

/** Mobile button in the chat header that opens the conversation list. */
export function ConversationListTrigger({ className }: { className?: string }) {
  const openList = use(OpenListContext);
  const t = useTranslations("chat.list");
  if (!openList) return null;
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      className={cn("-ml-2 shrink-0 text-muted-foreground md:hidden", className)}
      onClick={openList}
      aria-label={t("title")}
      title={t("title")}
    >
      <MessagesSquareIcon />
    </Button>
  );
}

/**
 * The conversation list with its project filter. The filter lives in the URL and the server lists the
 * matching conversations; changing it keeps the open conversation.
 */
export function ConversationPanel({ conversations, agents, projects, filterProjects, filter }: Props) {
  const params = useParams<{ id?: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations("chat.list");
  const { inSheet, close } = use(PlacementContext);
  const [creating, setCreating] = useState(false);
  const query = filterQuery(filter);
  const listRef = useRef<HTMLDivElement>(null);
  const setFilter = (value: string) => router.replace(`${pathname}${filterQuery(value)}`, { scroll: false });
  // Keep the open conversation visible when it is far down the list.
  useEffect(() => {
    listRef.current?.querySelector("[data-active=true]")?.scrollIntoView({ block: "nearest" });
  }, [params.id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex h-16 shrink-0 items-center justify-between gap-2 px-4", inSheet && "pr-12")}>
        <span className="flex items-baseline gap-1.5 text-sm font-semibold">
          {t("title")}
          {conversations.length > 0 && (
            <span className="tabular text-xs font-normal text-muted-foreground">{conversations.length}</span>
          )}
        </span>
        <Button size="sm" variant="outline" className="bg-card/70" onClick={() => setCreating(true)}>
          <SquarePenIcon /> {t("new")}
        </Button>
        <NewConversationDialog
          open={creating}
          onOpenChange={setCreating}
          agents={agents}
          projects={projects}
          initialProjectId={filter === ALL || filter === NO_PROJECT ? undefined : filter}
          // A filtered list switches to the new conversation's project, so the conversation shows in it.
          hrefFor={(id, projectId) => `/chat/${id}${filter === ALL ? "" : filterQuery(projectId ?? NO_PROJECT)}`}
        />
      </div>
      {(filterProjects.length > 0 || filter !== ALL) && (
        <div className="shrink-0 px-3 pb-2">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger
              size="sm"
              aria-label={t("filterLabel")}
              className={cn(
                "w-full bg-background/70 *:data-[slot=select-value]:flex *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2",
                filter !== ALL && "border-primary/40 bg-primary/5 dark:bg-primary/10",
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-w-[calc(100vw-2rem)]">
              <SelectItem value={ALL}>
                <ListIcon className="text-muted-foreground" />
                <span className="truncate">{t("filterAll")}</span>
              </SelectItem>
              <SelectItem value={NO_PROJECT}>
                <GlobeIcon className="text-muted-foreground" />
                <span className="truncate">{t("filterNoProject")}</span>
              </SelectItem>
              <SelectSeparator />
              {filterProjects.map((p) => (
                <SelectItem key={p.id} value={p.id} className="*:[span]:last:min-w-0">
                  <FolderKanbanIcon className="text-muted-foreground" />
                  <span className="truncate">{p.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div aria-hidden className="mx-4 h-px shrink-0 bg-linear-to-r from-border via-border/50 to-transparent" />
      <div ref={listRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <ul className="flex flex-col gap-1 p-2">
          {conversations.length === 0 && (
            <li className="px-2 py-3 text-sm text-muted-foreground">{filter === ALL ? t("empty") : t("emptyFiltered")}</li>
          )}
          {conversations.map((c) => {
            const active = params.id === c.id;
            return (
              <li
                key={c.id}
                data-active={active}
                className={cn(
                  "group relative flex min-w-0 items-center gap-3 rounded-xl py-2 pr-1.5 pl-2 text-sm transition-colors hover:bg-background/70 dark:hover:bg-muted/50",
                  active &&
                    "bg-card shadow-[0_1px_2px_rgb(0_0_0/0.05)] ring-1 ring-border/70 hover:bg-card dark:bg-muted/70 dark:hover:bg-muted/70",
                )}
              >
                <Link
                  href={`/chat/${c.id}${query}`}
                  onClick={close}
                  aria-current={active ? "page" : undefined}
                  className="absolute inset-0 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  aria-label={c.title}
                />
                <AgentAvatar avatar={c.agentAvatar} size="lg" />
                <div className="min-w-0 flex-1">
                  <div
                    className={cn("truncate leading-snug", active ? "font-medium" : "text-foreground/90")}
                    title={c.title}
                  >
                    {c.title}
                  </div>
                  <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    {c.channel === "telegram" && <Send className="size-3 shrink-0" />}
                    {/* The project is implied while the list is filtered by it. */}
                    {c.project && filter !== c.project.id && (
                      <span
                        className="flex max-w-[50%] min-w-0 shrink-0 items-center gap-1"
                        title={t("inProject", { project: c.project.name })}
                      >
                        <FolderKanbanIcon className="size-3 shrink-0" aria-hidden />
                        <span className="truncate font-medium text-foreground/75">{c.project.name}</span>
                        <span aria-hidden>·</span>
                      </span>
                    )}
                    <span className="truncate">
                      {c.agentName} · <RelativeTime date={c.updatedAt} />
                    </span>
                  </div>
                </div>
                <DeleteConversation id={c.id} title={c.title} active={active} query={query} />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Deleting removes the whole history, so it asks first (the button is always visible on touch screens). */
function DeleteConversation({ id, title, active, query }: { id: string; title: string; active: boolean; query: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const t = useTranslations("chat.list");
  const tCommon = useTranslations("common.actions");
  const remove = () =>
    start(async () => {
      const res = await deleteConversation({ id });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("deleted"));
      // Leaving a deleted conversation: /chat opens the latest one of the list (or offers a new one).
      if (active) router.replace(`/chat${query}`);
    });

  return (
    <ConfirmDialog
      trigger={
        <Button
          size="icon"
          variant="ghost"
          disabled={pending}
          className={cn(
            "relative shrink-0 text-muted-foreground hover:text-destructive md:size-7 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100",
            (active || pending) && "md:opacity-100",
          )}
          aria-label={t("delete")}
        >
          {pending ? <Spinner /> : <Trash2 />}
        </Button>
      }
      title={t("deleteTitle", { title })}
      description={t("deleteDescription")}
      titleClassName="wrap-anywhere"
      confirm={tCommon("delete")}
      destructive
      onConfirm={remove}
    />
  );
}
