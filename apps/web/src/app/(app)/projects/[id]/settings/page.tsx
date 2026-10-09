import { PROVIDER_IDS, PROVIDERS } from "@abotica/core";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/app/back-link";
import { PageBody } from "@/components/app/page-header";
import { ProjectDangerZone } from "@/components/projects/project-danger-zone";
import { ProjectForm } from "@/components/projects/project-form";
import { isUuid } from "@/lib/uuid";
import { getProject } from "@/server/queries/projects";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("projects");
  return { title: t("meta.settingsTitle") };
}

export default async function ProjectSettingsPage(props: PageProps<"/projects/[id]/settings">) {
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const [project, t] = await Promise.all([getProject(id), getTranslations("projects")]);
  if (!project) notFound();
  const providers = PROVIDER_IDS.map((p) => ({ id: p, label: PROVIDERS[p].label }));

  return (
    <PageBody>
      <BackLink href={`/projects/${project.id}`}>{t("settings.back")}</BackLink>
      {/* The editable name in the form is the visible title, so the page heading is for screen readers only. */}
      <h1 className="sr-only">{t("settings.title")}</h1>
      <ProjectForm
        projectId={project.id}
        providers={providers}
        initial={{
          name: project.name,
          description: project.description,
          goals: project.goals,
          budgetUsd: project.budgetUsd,
          allowedProviders: project.allowedProviders,
          telegramTopicId: project.telegramTopicId,
        }}
        footer={<ProjectDangerZone projectId={project.id} name={project.name} archived={project.status === "archived"} />}
      />
    </PageBody>
  );
}
