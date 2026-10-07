import { RUN_CANCELLED_BY_USER, type RunFailureKind } from "@abotica/core";
import { CircleAlert, OctagonX } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

/**
 * Why a run failed or was cancelled: the stored error, and for runs that recorded their failure kind,
 * the kind with a hint on what to do about it.
 */
export function RunFailureAlert({
  status,
  error,
  failureKind,
}: {
  status: "failed" | "cancelled";
  error: string | null;
  failureKind: RunFailureKind | null;
}) {
  const t = useTranslations("runs");
  if (!error && !failureKind) return null;
  const failed = status === "failed";
  return (
    <Alert
      variant={failed ? "destructive" : "default"}
      className={failed ? "border-destructive/25 bg-destructive/5" : undefined}
    >
      {failed ? <CircleAlert /> : <OctagonX />}
      <AlertTitle className="flex flex-wrap items-center gap-2">
        {failed ? t("detail.failedTitle") : t("detail.cancelledTitle")}
        {failureKind && (
          <Badge variant="outline" className="font-normal">
            {t(`failure.${failureKind}.label`)}
          </Badge>
        )}
      </AlertTitle>
      <AlertDescription className="space-y-1 wrap-anywhere [&_p:not(:last-child)]:mb-0">
        {error && <p>{error === RUN_CANCELLED_BY_USER ? t("detail.cancelledByUser") : error}</p>}
        {failureKind && <p className="text-muted-foreground">{t(`failure.${failureKind}.hint`)}</p>}
      </AlertDescription>
    </Alert>
  );
}
