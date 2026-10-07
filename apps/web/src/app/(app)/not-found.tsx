import { SearchX } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { PageBody } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";

export default function AppNotFound() {
  const t = useTranslations("shell.notFound");
  return (
    <PageBody className="min-h-[70svh] items-center justify-center">
      <div className="flex max-w-sm flex-col items-center gap-5 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/8 text-primary ring-1 ring-primary/10 dark:bg-primary/15">
          <SearchX className="size-6" aria-hidden />
        </span>
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-muted-foreground tabular">404</p>
          <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-sm text-pretty text-muted-foreground">{t("description")}</p>
        </div>
        <Button asChild>
          <Link href="/">{t("back")}</Link>
        </Button>
      </div>
    </PageBody>
  );
}
