"use client";

import { BotIcon, FilesIcon, FolderKanbanIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";
import { listCardClass, SectionEmptyLink, sectionCardClass } from "@/components/app/section-card";
import { Badge } from "@/components/ui/badge";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { setSkillEnabled } from "@/server/actions/skills";
import type { SkillListItem } from "@/server/queries/skills";
import { SkillIcon } from "./skill-icon";

export function SkillList({ skills }: { skills: SkillListItem[] }) {
  const t = useTranslations("skills.list");
  const [query, setQuery] = useState("");
  const [, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(skills, (state, patch: { id: string; enabled: boolean }) =>
    state.map((s) => (s.id === patch.id ? { ...s, enabled: patch.enabled } : s)),
  );

  if (!skills.length) {
    return (
      <p className={cn(sectionCardClass, "px-4 py-4 text-sm text-muted-foreground sm:px-5")}>
        {t.rich("empty", {
          discover: (chunks) => <SectionEmptyLink href="/skills?tab=discover">{chunks}</SectionEmptyLink>,
          create: (chunks) => <SectionEmptyLink href="/skills/new">{chunks}</SectionEmptyLink>,
        })}
      </p>
    );
  }

  const q = query.trim().toLowerCase();
  const visible = q
    ? optimistic.filter((s) => [s.name, s.slug, s.description].some((v) => v.toLowerCase().includes(q)))
    : optimistic;

  function toggle(id: string, enabled: boolean) {
    startTransition(async () => {
      setOptimistic({ id, enabled });
      const res = await setSkillEnabled({ id, enabled });
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <InputGroup className="max-w-sm">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search")}
          aria-label={t("searchAria")}
        />
      </InputGroup>
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t.rich("noMatch", {
            link: (chunks) => (
              <SectionEmptyLink href={`/skills?tab=discover&q=${encodeURIComponent(query.trim())}`}>
                {chunks}
              </SectionEmptyLink>
            ),
          })}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((s) => (
            <div key={s.id} className={cn(listCardClass, !s.enabled && "bg-card/60 dark:bg-card/40")}>
              <div className="flex items-center gap-3">
                <SkillIcon size="xl" className={cn(!s.enabled && "opacity-60")} />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/skills/${s.id}`}
                    title={s.name}
                    className="line-clamp-2 font-medium wrap-anywhere after:absolute after:inset-0 after:rounded-xl"
                  >
                    {s.name}
                  </Link>
                  <p className="truncate font-mono text-sm text-muted-foreground" title={s.slug}>
                    {s.slug}
                  </p>
                </div>
                <div className="relative z-10">
                  <Switch
                    checked={s.enabled}
                    onCheckedChange={(v) => toggle(s.id, v)}
                    aria-label={s.enabled ? t("disable", { name: s.name }) : t("enable", { name: s.name })}
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {s.source && (
                  <Badge variant="outline" className="font-normal" title={s.source.url}>
                    {s.source.kind === "skills.sh" ? "skills.sh" : "GitHub"}
                  </Badge>
                )}
                <Badge variant="secondary" className="tabular font-normal">
                  <FilesIcon aria-hidden /> {t("files", { count: s.fileCount })}
                </Badge>
                <Badge variant="secondary" className="tabular font-normal" title={t("version")}>
                  v{s.version}
                </Badge>
              </div>

              <p
                className={cn(
                  "line-clamp-2 text-sm wrap-anywhere",
                  s.description ? "text-muted-foreground" : "text-muted-foreground/60",
                )}
                title={s.description || undefined}
              >
                {s.description || t("noDescription")}
              </p>

              <div className="mt-auto flex items-center border-t pt-3">
                <div className="flex gap-3 text-xs text-muted-foreground">
                  <span className="tabular inline-flex items-center gap-1">
                    <BotIcon className="size-3.5" aria-hidden /> {t("agents", { count: s.agentCount })}
                  </span>
                  <span className="tabular inline-flex items-center gap-1">
                    <FolderKanbanIcon className="size-3.5" aria-hidden /> {t("projects", { count: s.projectCount })}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
