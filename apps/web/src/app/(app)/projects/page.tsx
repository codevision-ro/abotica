import { PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { SectionEmptyLink } from "@/components/app/section-card";
import { TabNav } from "@/components/app/tab-nav";
import { ProjectCard } from "@/components/projects/project-card";
import { Button } from "@/components/ui/button";
import { listProjects, type ProjectFilter } from "@/server/queries/projects";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("projects");
  return { title: t("meta.title") };
}

const FILTERS: ProjectFilter[] = ["active", "all", "archived"];

export default async function ProjectsPage(props: PageProps<"/projects">) {
  const sp = await props.searchParams;
  const filter: ProjectFilter = sp.filter === "all" || sp.filter === "archived" ? sp.filter : "active";
  const [projects, t] = await Promise.all([listProjects(filter), getTranslations("projects")]);

  return (
    <PageBody>
      <PageHeader
        title={t("list.title")}
        description={t("list.description")}
        actions={
          <Button asChild>
            <Link href="/projects/new">
              <PlusIcon />
              {t("list.newProject")}
            </Link>
          </Button>
        }
      />
      <TabNav
        items={FILTERS.map((f) => ({
          href: f === "active" ? "/projects" : `/projects?filter=${f}`,
          label: t(`list.filters.${f}`),
          active: f === filter,
        }))}
      />
      {projects.length ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
          {t.rich(`list.empty.${filter}`, {
            link: (chunks) => <SectionEmptyLink href="/projects/new">{chunks}</SectionEmptyLink>,
          })}
        </p>
      )}
    </PageBody>
  );
}
