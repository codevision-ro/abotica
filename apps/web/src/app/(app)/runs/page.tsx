import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { sectionCardClass, SectionEmpty, SectionEmptyLink } from "@/components/app/section-card";
import { RunsFilters } from "@/components/runs/runs-filters";
import { RunsTable } from "@/components/runs/runs-table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getRunFilterOptions, getRunPage, RUNS_PAGE_SIZE } from "@/server/queries/runs";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("runs");
  return { title: t("meta.title") };
}

const chatLink = (chunks: React.ReactNode) => <SectionEmptyLink href="/chat">{chunks}</SectionEmptyLink>;
const resetLink = (chunks: React.ReactNode) => <SectionEmptyLink href="/runs">{chunks}</SectionEmptyLink>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function PageButton({ href, label, children }: { href: string | null; label: string; children: React.ReactNode }) {
  return (
    <Button variant="ghost" size="icon-sm" asChild={Boolean(href)} disabled={!href} aria-label={label}>
      {href ? <Link href={href}>{children}</Link> : children}
    </Button>
  );
}

export default async function RunsPage(props: PageProps<"/runs">) {
  const sp = await props.searchParams;
  const t = await getTranslations("runs");
  const filters = {
    status: first(sp.status),
    agent: first(sp.agent),
    trigger: first(sp.trigger),
    project: first(sp.project),
    page: Number(first(sp.page)) || 1,
  };
  const [{ rows, total, page, pageCount }, options] = await Promise.all([getRunPage(filters), getRunFilterOptions()]);
  const filtered = Boolean(filters.status || filters.agent || filters.trigger || filters.project);

  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (k !== "page" && v) params.set(k, String(v));
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/runs?${qs}` : "/runs";
  };

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
            <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-2 text-xs text-muted-foreground sm:px-5">
              <span className="tabular">
                {t("list.range", {
                  from: (page - 1) * RUNS_PAGE_SIZE + 1,
                  to: (page - 1) * RUNS_PAGE_SIZE + rows.length,
                  total,
                })}
              </span>
              {pageCount > 1 && (
                <div className="flex items-center gap-0.5">
                  <PageButton href={page > 1 ? pageHref(page - 1) : null} label={t("list.previousPage")}>
                    <ChevronLeft />
                  </PageButton>
                  <span className="tabular px-1.5">
                    {page} / {pageCount}
                  </span>
                  <PageButton href={page < pageCount ? pageHref(page + 1) : null} label={t("list.nextPage")}>
                    <ChevronRight />
                  </PageButton>
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </PageBody>
  );
}
