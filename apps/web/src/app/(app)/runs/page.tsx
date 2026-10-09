import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { ListPager, pageHref } from "@/components/app/list-pager";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { sectionCardClass, SectionEmpty, SectionEmptyLink } from "@/components/app/section-card";
import { RunsFilters } from "@/components/runs/runs-filters";
import { RunsTable } from "@/components/runs/runs-table";
import { cn } from "@/lib/utils";
import { getRunFilterOptions, getRunPage, RUNS_PAGE_SIZE } from "@/server/queries/runs";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("runs");
  return { title: t("meta.title") };
}

const chatLink = (chunks: React.ReactNode) => <SectionEmptyLink href="/chat">{chunks}</SectionEmptyLink>;
const resetLink = (chunks: React.ReactNode) => <SectionEmptyLink href="/runs">{chunks}</SectionEmptyLink>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function RunsPage(props: PageProps<"/runs">) {
  const sp = await props.searchParams;
  const t = await getTranslations("runs");
  const listFilters = {
    status: first(sp.status),
    agent: first(sp.agent),
    trigger: first(sp.trigger),
    project: first(sp.project),
  };
  const filters = { ...listFilters, page: Number(first(sp.page)) || 1 };
  const [{ rows, total, page }, options] = await Promise.all([getRunPage(filters), getRunFilterOptions()]);
  const filtered = Boolean(filters.status || filters.agent || filters.trigger || filters.project);

  const href = (p: number) => pageHref("/runs", listFilters, p);

  return (
    <PageBody>
      <PageHeader title={t("list.title")} description={t("list.description")} />
      <section aria-label={t("list.title")} className={cn(sectionCardClass, "min-w-0 overflow-hidden")}>
        <div className="px-4 py-3 sm:px-5">
          <Suspense>
            <RunsFilters agents={options.agents} projects={options.projects} />
          </Suspense>
        </div>
        <div aria-hidden className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />
        {rows.length === 0 ? (
          <SectionEmpty className="py-6">
            {filtered ? t.rich("list.emptyFiltered", { link: resetLink }) : t.rich("list.empty", { link: chatLink })}
          </SectionEmpty>
        ) : (
          <>
            <RunsTable rows={rows} />
            <ListPager page={page} pageSize={RUNS_PAGE_SIZE} rowCount={rows.length} total={total} href={href} />
          </>
        )}
      </section>
    </PageBody>
  );
}
