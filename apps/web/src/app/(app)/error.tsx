"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { PageBody } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";

/** An unexpected error in a page: shown inside the app frame, so the sidebar stays usable. */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations("shell");

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageBody className="min-h-[70svh] items-center justify-center">
      <div role="alert" className="flex max-w-sm flex-col items-center gap-5 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-destructive/8 text-destructive ring-1 ring-destructive/10 dark:bg-destructive/15">
          <TriangleAlert className="size-6" aria-hidden />
        </span>
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight">{t("error.title")}</h1>
          <p className="text-sm text-pretty text-muted-foreground">{t("error.description")}</p>
          {/* Server errors reach the client without their message; the digest matches the server log. */}
          {error.digest && (
            <p className="font-mono text-xs text-muted-foreground">{t("error.reference", { digest: error.digest })}</p>
          )}
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => retry()}>{t("error.retry")}</Button>
          <Button variant="outline" asChild>
            <Link href="/">{t("notFound.back")}</Link>
          </Button>
        </div>
      </div>
    </PageBody>
  );
}
