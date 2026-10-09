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

/**
 * The footer of a paged list in a section card: which rows are shown out of how many, and previous/next
 * links (`href` builds a page's URL, keeping the list's filters) once there is more than one page.
 */
export function ListPager({
  page,
  pageSize,
  rowCount,
  total,
  href,
  className,
}: {
  page: number;
  pageSize: number;
  /** Rows on this page. */
  rowCount: number;
  total: number;
  href: (page: number) => string;
  className?: string;
}) {
  const t = useTranslations("common.pagination");
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize;
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 border-t border-border/60 px-4 py-2 text-xs text-muted-foreground sm:px-5",
        className,
      )}
    >
      <span className="tabular">{t("range", { from: from + 1, to: from + rowCount, total })}</span>
      {pageCount > 1 && (
        <div className="flex items-center gap-0.5">
          <PageButton href={page > 1 ? href(page - 1) : null} label={t("previous")}>
            <ChevronLeft />
          </PageButton>
          <span className="tabular px-1.5">
            {page} / {pageCount}
          </span>
          <PageButton href={page < pageCount ? href(page + 1) : null} label={t("next")}>
            <ChevronRight />
          </PageButton>
        </div>
      )}
    </div>
  );
}
