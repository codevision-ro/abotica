import { PROVIDER_IDS, PROVIDERS } from "@abotica/core";
import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { PageBody } from "@/components/app/page-header";
import { ProjectDangerZone } from "@/components/projects/project-danger-zone";
import { ProjectForm } from "@/components/projects/project-form";
import { Button } from "@/components/ui/button";
import { isUuid } from "@/lib/uuid";
import { getProject } from "@/server/queries/projects";
import { getAppSettings } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("projects");
  return { title: t("meta.settingsTitle") };
}

export default async function ProjectSettingsPage(props: PageProps<"/projects/[id]/settings">) {
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const [project, settings, t] = await Promise.all([getProject(id), getAppSettings(), getTranslations("projects")]);
  if (!project) notFound();
  const providers = PROVIDER_IDS.map((p) => ({ id: p, label: PROVIDERS[p].label }));

  return (
    <PageBody>
      <Button variant="ghost" size="sm" className="-mb-2 self-start" asChild>
        <Link href={`/projects/${project.id}`}>
          <ArrowLeftIcon /> {t("settings.back")}
        </Link>
      </Button>
      {/* The editable name in the form is the visible title, so the page heading is for screen readers only. */}
      <h1 className="sr-only">{t("settings.title")}</h1>
      <ProjectForm
        projectId={project.id}
        providers={providers}
        sandboxDefault={settings.sandbox.defaults}
        initial={{
          name: project.name,
          description: project.description,
          goals: project.goals,
          budgetUsd: project.budgetUsd,
          allowedProviders: project.allowedProviders,
          telegramTopicId: project.telegramTopicId,
          sandbox: project.sandbox,
        }}
        footer={<ProjectDangerZone projectId={project.id} name={project.name} archived={project.status === "archived"} />}
      />
    </PageBody>
  );
}
