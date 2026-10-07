import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Previous/next links that keep the other query params. */
export function PageLinks({
  basePath,
  params,
  page,
  hasNext,
  label,
  className,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  page: number;
  hasNext: boolean;
  label?: string;
  className?: string;
}) {
  const t = useTranslations("memory.pagination");
  if (page <= 1 && !hasNext) return null;
  const href = (p: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, page: p > 1 ? String(p) : undefined })) if (v) qs.set(k, v);
    const s = qs.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  return (
    <nav aria-label={t("aria")} className={cn("flex items-center justify-between gap-2", className)}>
      <span className="tabular min-w-0 truncate text-sm text-muted-foreground">{label ?? t("page", { page })}</span>
      <div className="flex shrink-0 gap-2">
        {page > 1 ? (
          <Button variant="outline" size="sm" className="max-sm:size-9" asChild>
            <Link href={href(page - 1)}>
              <ChevronLeft /> <span className="max-sm:sr-only">{t("previous")}</span>
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="max-sm:size-9" disabled>
            <ChevronLeft /> <span className="max-sm:sr-only">{t("previous")}</span>
          </Button>
        )}
        {hasNext ? (
          <Button variant="outline" size="sm" className="max-sm:size-9" asChild>
            <Link href={href(page + 1)}>
              <span className="max-sm:sr-only">{t("next")}</span> <ChevronRight />
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="max-sm:size-9" disabled>
            <span className="max-sm:sr-only">{t("next")}</span> <ChevronRight />
          </Button>
        )}
      </div>
    </nav>
  );
}
