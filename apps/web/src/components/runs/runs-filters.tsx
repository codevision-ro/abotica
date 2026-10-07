"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RUN_STATUSES, TRIGGERS, useStatusLabels } from "@/components/app/status-badge";
import { cn } from "@/lib/utils";
import { RUNS_LIST_KEY } from "./runs-back-link";

const ALL = "__all";

type Option = { value: string; label: string; avatar?: AgentAvatarValue };

function FilterSelect({
  name,
  label,
  options,
  value,
  onChange,
}: {
  name: string;
  label: string;
  options: Option[];
  value: string | undefined;
  onChange: (name: string, value: string | null) => void;
}) {
  const t = useTranslations("runs.filters");
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(name, v === ALL ? null : v)}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        className={cn(
          "w-full min-w-0 bg-background/60 max-sm:data-[size=sm]:h-9 sm:w-auto sm:max-w-56 sm:min-w-32 dark:bg-input/20",
          value && "border-primary/40 bg-primary/5 dark:bg-primary/10",
        )}
      >
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent className="max-w-[min(24rem,calc(100vw-2rem))]">
        <SelectItem value={ALL}>{t("all", { label })}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} title={o.label} className="*:[span]:last:min-w-0">
            {o.avatar && <AgentAvatar avatar={o.avatar} size="xs" />}
            <span className="truncate">{o.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function RunsFilters({
  agents,
  projects,
}: {
  agents: { id: string; name: string; avatar: AgentAvatarValue }[];
  projects: { id: string; name: string }[];
}) {
  const t = useTranslations("runs.filters");
  const labels = useStatusLabels();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Remembered for the "back to runs" link on the run page.
  useEffect(() => {
    const qs = searchParams.toString();
    try {
      sessionStorage.setItem(RUNS_LIST_KEY, qs ? `${pathname}?${qs}` : pathname);
    } catch {}
  }, [pathname, searchParams]);

  const update = (name: string, value: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(name, value);
    else params.delete(name);
    params.delete("page");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const current = (name: string) => searchParams.get(name) ?? undefined;
  const active = ["status", "agent", "trigger", "project"].some((k) => searchParams.has(k));

  return (
    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
      <FilterSelect
        name="status"
        label={t("status")}
        value={current("status")}
        onChange={update}
        options={RUN_STATUSES.map((value) => ({ value, label: labels.run(value) }))}
      />
      <FilterSelect
        name="agent"
        label={t("agent")}
        value={current("agent")}
        onChange={update}
        options={agents.map((a) => ({ value: a.id, label: a.name, avatar: a.avatar }))}
      />
      <FilterSelect
        name="trigger"
        label={t("trigger")}
        value={current("trigger")}
        onChange={update}
        options={TRIGGERS.map((value) => ({ value, label: labels.trigger(value) }))}
      />
      {projects.length > 0 && (
        <FilterSelect
          name="project"
          label={t("project")}
          value={current("project")}
          onChange={update}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
        />
      )}
      {active && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => router.replace(pathname, { scroll: false })}
        >
          <X />
          {t("reset")}
        </Button>
      )}
    </div>
  );
}
