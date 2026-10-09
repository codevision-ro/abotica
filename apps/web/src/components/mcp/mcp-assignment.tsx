"use client";

import { UsersRoundIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { FormSection } from "@/components/app/form-section";
import { SummaryItem } from "@/components/app/summary-rail";
import type { PickerOption } from "@/components/skills/assignment-picker";
import { AssignmentChips } from "./assignment-chips";
import { McpSwitchRow } from "./mcp-switch-row";

/** Who gets a server: every agent (`global`, the assignments are kept for when it is turned off) or the assigned ones. */
export type McpAssignment = { enabled: boolean; global: boolean; agentIds: string[]; projectIds: string[] };

/** The assignment's lines in the summary rail: who gets the server, and whether it is active. */
export function McpAssignmentSummary({ target, value }: { target: string; value: McpAssignment }) {
  const t = useTranslations("mcp.form");
  const tl = useTranslations("mcp.list");
  return (
    <>
      <SummaryItem target={target} status="info" label={t("assignmentTitle")}>
        {value.global
          ? t("globalSummary")
          : `${tl("agents", { count: value.agentIds.length })} · ${tl("projects", { count: value.projectIds.length })}`}
      </SummaryItem>
      <SummaryItem target={target} status="info" label={t("statusTitle")}>
        {value.enabled ? t("active") : t("inactive")}
      </SummaryItem>
    </>
  );
}

const createLink = (href: string) =>
  function RichLink(chunks: React.ReactNode) {
    return (
      <Link href={href} className="underline underline-offset-2">
        {chunks}
      </Link>
    );
  };

/** "Available to all agents" or the agents and projects that get the server, then "Active". */
export function McpAssignmentSection({
  id,
  value,
  onChange,
  agents,
  projects,
}: {
  /** Section id, the rail's scroll target. */
  id: string;
  value: McpAssignment;
  onChange: React.Dispatch<React.SetStateAction<McpAssignment>>;
  agents: PickerOption[];
  projects: PickerOption[];
}) {
  const t = useTranslations("mcp.form");
  const set = (patch: Partial<McpAssignment>) => onChange((prev) => ({ ...prev, ...patch }));
  return (
    <FormSection id={id} icon={UsersRoundIcon} title={t("assignmentTitle")} description={t("assignmentDescription")}>
      <McpSwitchRow
        id="mcp-global"
        title={t("globalTitle")}
        hint={t("globalHint")}
        checked={value.global}
        onCheckedChange={(global) => set({ global })}
      />
      {value.global ? (
        <p className="text-sm text-pretty text-muted-foreground">{t("globalOn")}</p>
      ) : (
        <>
          <AssignmentChips
            title={t("agents")}
            items={agents}
            selected={value.agentIds}
            onChange={(agentIds) => set({ agentIds })}
            empty={t.rich("noAgents", { link: createLink("/agents/new") })}
          />
          <AssignmentChips
            title={t("projects")}
            items={projects}
            selected={value.projectIds}
            onChange={(projectIds) => set({ projectIds })}
            empty={t.rich("noProjects", { link: createLink("/projects/new") })}
          />
        </>
      )}
      <McpSwitchRow
        id="mcp-enabled"
        title={t("active")}
        hint={t("activeHint")}
        checked={value.enabled}
        onCheckedChange={(enabled) => set({ enabled })}
      />
    </FormSection>
  );
}
