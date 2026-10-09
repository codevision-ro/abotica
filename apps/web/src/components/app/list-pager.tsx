import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function PageButton({ href, label, children }: { href: string | null; label: string; children: React.ReactNode }) {
  return (
    <Button variant="ghost" size="icon-sm" asChild={Boolean(href)} disabled={!href} aria-label={label}>
      {href ? <Link href={href}>{children}</Link> : children}
    </Button>
  );
}

/** A list whose size is known: the rows shown out of how many. */
type Counted = { pageSize: number; rowCount: number; total: number; hasNext?: never };
/** A list paged without a count (the journal's days): only whether a next page exists. */
type Open = { hasNext: boolean; pageSize?: never; rowCount?: never; total?: never };

/**
 * The footer of a paged list: which rows are shown out of how many (or the page, when the list has no
 * count), and previous/next links (`href` builds a page's URL, keeping the list's filters) once there is
 * more than one page. Nothing at all for a single page without a count.
 */
export function ListPager({
  page,
  href,
  className,
  ...size
}: { page: number; href: (page: number) => string; className?: string } & (Counted | Open)) {
  const t = useTranslations("common.pagination");
  const pageCount = size.total === undefined ? null : Math.max(1, Math.ceil(size.total / size.pageSize));
  const hasNext = pageCount === null ? Boolean(size.hasNext) : page < pageCount;
  if (pageCount === null && page <= 1 && !hasNext) return null;
  const from = size.total === undefined ? 0 : (page - 1) * size.pageSize;
  return (
    <nav
      aria-label={t("aria")}
      className={cn(
        "flex items-center justify-between gap-2 border-t border-border/60 px-4 py-2 text-xs text-muted-foreground sm:px-5",
        className,
      )}
    >
      <span className="tabular">
        {size.total === undefined
          ? t("page", { page })
          : t("range", { from: from + 1, to: from + size.rowCount, total: size.total })}
      </span>
      {(page > 1 || hasNext) && (
        <div className="flex items-center gap-0.5">
          <PageButton href={page > 1 ? href(page - 1) : null} label={t("previous")}>
            <ChevronLeft />
          </PageButton>
          {pageCount !== null && (
            <span className="tabular px-1.5">
              {page} / {pageCount}
            </span>
          )}
          <PageButton href={hasNext ? href(page + 1) : null} label={t("next")}>
            <ChevronRight />
          </PageButton>
        </div>
      )}
    </nav>
  );
}

/** A page's URL: `basePath` with the list's other query params, and the page from 2 on. */
export function pageHref(basePath: string, params: Record<string, string | undefined>, page: number): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, page: page > 1 ? String(page) : undefined })) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `${basePath}?${s}` : basePath;
}
