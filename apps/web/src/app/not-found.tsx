import Link from "next/link";
import { useTranslations } from "next-intl";
import { Logo } from "@/components/app/logo";
import { Button } from "@/components/ui/button";

/** Unmatched URLs outside the app shell; missing records inside the app use `(app)/not-found.tsx`. */
export default function NotFound() {
  const t = useTranslations("shell.notFound");
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden bg-background px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(55%_45%_at_50%_0%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)] dark:bg-[radial-gradient(55%_45%_at_50%_0%,color-mix(in_oklch,var(--primary)_18%,transparent),transparent)]"
      />
      <div className="relative z-10 flex max-w-sm flex-col items-center gap-6 text-center">
        <Logo className="size-11 rounded-xl shadow-md shadow-primary/20" />
        <div className="space-y-1.5">
          <p className="tabular text-sm font-medium text-muted-foreground">404</p>
          <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-sm text-pretty text-muted-foreground">{t("description")}</p>
        </div>
        <Button asChild>
          <Link href="/">{t("back")}</Link>
        </Button>
      </div>
    </div>
  );
}
