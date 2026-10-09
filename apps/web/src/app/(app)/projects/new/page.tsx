import { PROVIDER_IDS, PROVIDERS } from "@abotica/core";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { BackLink } from "@/components/app/back-link";
import { PageBody } from "@/components/app/page-header";
import { ProjectForm } from "@/components/projects/project-form";
import { listJoinableAgents, listLeadableAgents } from "@/server/queries/projects";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("projects");
  return { title: t("meta.newTitle") };
}

export default async function NewProjectPage() {
  const [specialists, managers, t] = await Promise.all([
    listJoinableAgents(),
    listLeadableAgents(),
    getTranslations("projects"),
  ]);
  const providers = PROVIDER_IDS.map((id) => ({ id, label: PROVIDERS[id].label }));

  return (
    <PageBody>
      <BackLink href="/projects">{t("new.back")}</BackLink>
      {/* The project's name in the form is the visible title; this one names the page for screen readers. */}
      <h1 className="sr-only">{t("new.title")}</h1>
      <ProjectForm specialists={specialists} managers={managers} providers={providers} />
    </PageBody>
  );
}
