import { HistoryIcon, SlidersHorizontalIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { BackLink } from "@/components/app/back-link";
import { PageBody } from "@/components/app/page-header";
import { ToneBadge } from "@/components/app/status-badge";
import { TabNav } from "@/components/app/tab-nav";
import { SkillForm } from "@/components/skills/skill-form";
import { SkillIcon } from "@/components/skills/skill-icon";
import { SkillVersionsTab } from "@/components/skills/skill-versions";
import { Badge } from "@/components/ui/badge";
import { isUuid } from "@/lib/uuid";
import { getAssignTargets, getSkill } from "@/server/queries/skills";

const TABS = ["config", "versions"] as const;

type TabId = (typeof TABS)[number];

async function load(id: string) {
  return isUuid(id) ? getSkill(id) : null;
}

export async function generateMetadata(props: PageProps<"/skills/[id]">): Promise<Metadata> {
  const skill = await load((await props.params).id);
  const t = await getTranslations("skills.meta");
  return { title: skill ? t("detail", { name: skill.name }) : t("fallback") };
}

export default async function SkillPage(props: PageProps<"/skills/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const [skill, targets, t] = await Promise.all([load(id), getAssignTargets(), getTranslations("skills")]);
  if (!skill) notFound();

  const tab: TabId = TABS.some((id) => id === sp.tab) ? (sp.tab as TabId) : "config";
  const v = typeof sp.v === "string" ? Number(sp.v) : undefined;

  const tabIcons: Record<TabId, React.ReactNode> = {
    config: <SlidersHorizontalIcon />,
    versions: <HistoryIcon />,
  };

  return (
    <PageBody>
      <BackLink href="/skills">{t("form.back")}</BackLink>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <SkillIcon size="2xl" />
        {/* basis keeps the title readable: below it the status wraps to its own row. */}
        <div className="min-w-0 flex-1 basis-56 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight" title={skill.name}>
              {skill.name}
            </h1>
            {skill.source && (
              <Badge variant="outline" title={t("detail.installedFrom", { url: skill.source.url })}>
                {skill.source.kind === "skills.sh" ? "skills.sh" : "GitHub"}
              </Badge>
            )}
          </div>
          <p className="line-clamp-2 text-sm text-muted-foreground wrap-anywhere" title={skill.description || undefined}>
            {skill.description || t("detail.noDescription")}
          </p>
        </div>
        <ToneBadge tone={skill.enabled ? "success" : "muted"}>
          {skill.enabled ? t("form.active") : t("form.inactive")}
        </ToneBadge>
      </div>

      <TabNav
        items={TABS.map((id) => ({
          href: `/skills/${skill.id}?tab=${id}`,
          label: t(`detail.tabs.${id}`),
          icon: tabIcons[id],
          active: id === tab,
        }))}
      />

      {tab === "config" && (
        <SkillForm
          key={`${skill.id}-${skill.version}`}
          mode={{ kind: "edit", skillId: skill.id, source: skill.source, modified: skill.modified }}
          initial={{
            name: skill.name,
            slug: skill.slug,
            description: skill.description,
            metadata: skill.metadata,
            files: skill.files,
            enabled: skill.enabled,
            agentIds: skill.agentIds,
            projectIds: skill.projectIds,
          }}
          agents={targets.agents}
          projects={targets.projects}
        />
      )}
      {tab === "versions" && <SkillVersionsTab skillId={skill.id} version={v} />}
    </PageBody>
  );
}
