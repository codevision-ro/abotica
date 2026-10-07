import { PROVIDER_IDS, PROVIDERS } from "@abotica/core";
import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageBody } from "@/components/app/page-header";
import { ProjectForm } from "@/components/projects/project-form";
import { Button } from "@/components/ui/button";
import { listJoinableAgents } from "@/server/queries/projects";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("projects");
  return { title: t("meta.newTitle") };
}

export default async function NewProjectPage() {
  const [specialists, t] = await Promise.all([listJoinableAgents(), getTranslations("projects")]);
  const providers = PROVIDER_IDS.map((id) => ({ id, label: PROVIDERS[id].label }));

  return (
    <PageBody>
      <Button variant="ghost" size="sm" className="-mb-2 self-start" asChild>
        <Link href="/projects">
          <ArrowLeftIcon /> {t("new.back")}
        </Link>
      </Button>
      {/* The project's name in the form is the visible title; this one names the page for screen readers. */}
      <h1 className="sr-only">{t("new.title")}</h1>
      <ProjectForm specialists={specialists} providers={providers} />
    </PageBody>
  );
}
