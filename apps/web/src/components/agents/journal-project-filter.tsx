"use client";

import { FolderKanbanIcon, GlobeIcon, ListIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type QueryParams, useQueryUpdate } from "@/hooks/use-query-update";
import { cn } from "@/lib/utils";

const ALL = "all";

/** The Journal tab's project filter, in `?project=`: a project id, "none" for work outside projects. */
export function JournalProjectFilter({
  params,
  projects,
}: {
  /** The tab's current query, kept when the filter changes. */
  params: QueryParams;
  projects: { id: string; name: string }[];
}) {
  const t = useTranslations("agents.journal");
  const { update } = useQueryUpdate(params);
  const value = params.project ?? ALL;
  return (
    <Select value={value} onValueChange={(v) => update({ project: v === ALL ? null : v })}>
      <SelectTrigger
        aria-label={t("filterLabel")}
        className={cn(
          "w-44 bg-background *:data-[slot=select-value]:flex *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2",
          value !== ALL && "border-primary/40 bg-primary/5 dark:bg-primary/10",
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-w-[calc(100vw-2rem)]">
        <SelectItem value={ALL}>
          <ListIcon className="text-muted-foreground" />
          <span className="truncate">{t("allProjects")}</span>
        </SelectItem>
        <SelectItem value="none">
          <GlobeIcon className="text-muted-foreground" />
          <span className="truncate">{t("noProject")}</span>
        </SelectItem>
        {projects.length > 0 && <SelectSeparator />}
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id} className="*:[span]:last:min-w-0">
            <FolderKanbanIcon className="text-muted-foreground" />
            <span className="truncate">{p.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
