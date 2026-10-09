"use client";

import { BotIcon, FolderIcon, KanbanIcon, ListIcon, PlusIcon, SearchIcon, SignalHighIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { chipVariants, SelectableChip } from "@/components/app/selectable-chip";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SEARCH_DEBOUNCE_MS } from "@/lib/search";
import { cn } from "@/lib/utils";
import type { TaskOptions } from "@/server/queries/tasks";
import { AgentSelectItem, PrioritySelectItems, SELECT_WITH_MEDIA } from "./task-icons";
import { rememberOverlayBase, saveTasksListHref, useTaskParams } from "./task-meta";

const ALL = "all";

export function NewTaskButton() {
  const t = useTranslations("tasks");
  const { openOverlay } = useTaskParams();
  return (
    <Button onClick={() => openOverlay({ new: "1", task: null })}>
      <PlusIcon />
      {t("newTask")}
    </Button>
  );
}

/** Inline text link that opens the new-task dialog, for one-line empty states. */
export function NewTaskLink({ children }: { children: React.ReactNode }) {
  const { hrefWith } = useTaskParams();
  return (
    <Link
      href={hrefWith({ new: "1", task: null })}
      scroll={false}
      onClick={rememberOverlayBase}
      className="underline underline-offset-2 hover:text-foreground"
    >
      {children}
    </Link>
  );
}

export function TaskToolbar({ options }: { options: TaskOptions }) {
  const t = useTranslations("tasks.toolbar");
  const tControl = useTranslations("tasks.control");
  const { searchParams, setParams } = useTaskParams();
  const urlQuery = searchParams.get("q") ?? "";
  const [query, setQuery] = useState(urlQuery);

  const pushed = useRef(urlQuery);

  useEffect(() => saveTasksListHref(searchParams), [searchParams]);

  // Sync from the URL only for external changes (back/forward), not for our own debounced writes.
  useEffect(() => {
    if (urlQuery !== pushed.current) {
      pushed.current = urlQuery;
      setQuery(urlQuery);
    }
  }, [urlQuery]);

  useEffect(() => {
    const next = query.trim();
    if (next === pushed.current) return;
    const timer = setTimeout(() => {
      pushed.current = next;
      setParams({ q: next || null }, "replace");
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, setParams]);

  const view = searchParams.get("view") === "list" ? "list" : "board";
  const project = searchParams.get("project") ?? ALL;
  const assignee = searchParams.get("assignee") ?? ALL;
  const priority = searchParams.get("priority") ?? ALL;
  const cancelled = searchParams.get("cancelled") === "1";
  const hasFilters = !!(
    urlQuery ||
    searchParams.get("project") ||
    searchParams.get("assignee") ||
    searchParams.get("priority") ||
    cancelled
  );

  const select = (key: string) => (value: string) => setParams({ [key]: value === ALL ? null : value }, "replace");

  const chip = (active: boolean) =>
    cn(
      chipVariants({ selected: active }),
      "h-8 w-auto max-w-56 gap-1.5 py-0 pr-2 pl-3 data-[size=default]:h-8 dark:hover:bg-muted",
      SELECT_WITH_MEDIA,
    );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <InputGroup className="h-8 w-full rounded-full bg-background sm:w-60 dark:bg-input/20">
        <InputGroupAddon className="pl-3">
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchLabel")}
        />
      </InputGroup>

      <Select value={project} onValueChange={select("project")}>
        <SelectTrigger aria-label={t("projectFilter")} className={chip(project !== ALL)}>
          <FolderIcon className="text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-w-[min(28rem,calc(100vw-2rem))]">
          <SelectItem value={ALL}>{t("allProjects")}</SelectItem>
          {options.projects.map((p) => (
            <SelectItem key={p.id} value={p.id} title={p.name} className="*:[span]:last:min-w-0">
              <span className="truncate">{p.name}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={assignee} onValueChange={select("assignee")}>
        <SelectTrigger aria-label={t("agentFilter")} className={chip(assignee !== ALL)}>
          {assignee === ALL && <BotIcon className="text-muted-foreground" />}
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-w-[min(28rem,calc(100vw-2rem))]">
          <SelectItem value={ALL}>{t("allAgents")}</SelectItem>
          {options.agents
            .filter((a) => a.assignable)
            .map((a) => (
              <AgentSelectItem key={a.id} agent={a} />
            ))}
        </SelectContent>
      </Select>

      <Select value={priority} onValueChange={select("priority")}>
        <SelectTrigger aria-label={t("priorityFilter")} className={chip(priority !== ALL)}>
          {priority === ALL && <SignalHighIcon className="text-muted-foreground" />}
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t("allPriorities")}</SelectItem>
          <PrioritySelectItems reversed />
        </SelectContent>
      </Select>

      {/* Cancelled tasks are over: hidden unless asked for. */}
      <SelectableChip selected={cancelled} onSelectedChange={(on) => setParams({ cancelled: on ? "1" : null }, "replace")}>
        {tControl("showCancelled")}
      </SelectableChip>

      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full text-muted-foreground"
          onClick={() => {
            pushed.current = "";
            setQuery("");
            setParams({ q: null, project: null, assignee: null, priority: null, cancelled: null }, "replace");
          }}
        >
          <XIcon />
          {t("reset")}
        </Button>
      )}

      <ToggleGroup
        type="single"
        spacing={0}
        size="sm"
        value={view}
        onValueChange={(v) => v && setParams({ view: v === "list" ? "list" : null }, "replace")}
        className="ml-auto rounded-full bg-muted p-0.5 dark:bg-muted/60"
        aria-label={t("viewMode")}
      >
        {(
          [
            ["board", KanbanIcon],
            ["list", ListIcon],
          ] as const
        ).map(([value, Icon]) => (
          <ToggleGroupItem
            key={value}
            value={value}
            aria-label={t(value)}
            className="h-7 gap-1.5 rounded-full! px-3! text-muted-foreground hover:bg-transparent data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs dark:data-[state=on]:bg-card"
          >
            <Icon />
            {t(value)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
