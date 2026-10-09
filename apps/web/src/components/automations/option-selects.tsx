"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { useTranslations } from "next-intl";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type Option = { id: string; name: string; avatar?: AgentAvatarValue | null };

const NONE = "__none";

export function AgentSelect({
  id,
  value,
  onChange,
  agents,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  agents: Option[];
}) {
  const t = useTranslations("automations.fields");
  return (
    <Select value={value} onValueChange={onChange}>
      {/* The selected agent shows with its avatar, side by side. */}
      <SelectTrigger
        id={id}
        className="w-full *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2"
      >
        <SelectValue placeholder={t("chooseAgent")} />
      </SelectTrigger>
      <SelectContent className="max-w-[calc(100vw-2rem)]">
        {agents.map((a) => (
          <SelectItem key={a.id} value={a.id} className="*:[span]:last:min-w-0">
            <AgentAvatar avatar={a.avatar} size="xs" />
            <span className="truncate">{a.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ProjectSelect({
  id,
  value,
  onChange,
  projects,
}: {
  id: string;
  value: string | null;
  onChange: (v: string | null) => void;
  projects: Option[];
}) {
  const t = useTranslations("automations.fields");
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-w-[calc(100vw-2rem)]">
        <SelectItem value={NONE}>{t("noProject")}</SelectItem>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id} className="*:[span]:last:min-w-0">
            <span className="truncate">{p.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
