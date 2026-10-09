import { SKILL_MD } from "@abotica/core/skill-md";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { BackLink } from "@/components/app/back-link";
import { PageBody } from "@/components/app/page-header";
import { SkillForm } from "@/components/skills/skill-form";
import { getAssignTargets } from "@/server/queries/skills";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("skills.meta");
  return { title: t("new") };
}

export default async function NewSkillPage() {
  const [targets, t] = await Promise.all([getAssignTargets(), getTranslations("skills")]);
  return (
    <PageBody>
      <BackLink href="/skills">{t("form.back")}</BackLink>
      {/* The skill name in the form is the visible title; this one names the page for screen readers. */}
      <h1 className="sr-only">{t("meta.new")}</h1>
      <SkillForm
        mode={{ kind: "create" }}
        initial={{
          name: "",
          slug: "",
          description: "",
          metadata: {},
          files: [{ path: SKILL_MD, content: t("editor.template") }],
          enabled: true,
          agentIds: [],
          projectIds: [],
        }}
        agents={targets.agents}
        projects={targets.projects}
      />
    </PageBody>
  );
}
