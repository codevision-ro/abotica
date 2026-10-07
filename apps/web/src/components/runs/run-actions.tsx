"use client";

import { Ban, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cancelRun, retryRun } from "@/server/actions/runs";

export function RunActions({ id, canCancel, canRerun }: { id: string; canCancel: boolean; canRerun: boolean }) {
  const t = useTranslations("runs.actions");
  const router = useRouter();
  const [pending, start] = useTransition();

  const cancel = () =>
    start(async () => {
      const res = await cancelRun({ id });
      if (!res.ok) toast.error(res.error);
      else toast.success(t("cancelled"));
    });

  const rerun = () =>
    start(async () => {
      const res = await retryRun({ id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(t("restarted"));
      router.push(`/runs/${res.data.id}`);
    });

  if (!canCancel && !canRerun) return null;
  return (
    <>
      {canCancel && (
        <ConfirmDialog
          trigger={
            <Button variant="outline" size="sm" disabled={pending}>
              {pending ? <Spinner /> : <Ban />}
              {t("cancel")}
            </Button>
          }
          title={t("cancelTitle")}
          description={t("cancelDescription")}
          cancel={t("keep")}
          confirm={t("cancel")}
          destructive
          onConfirm={cancel}
        />
      )}
      {canRerun && (
        <Button size="sm" disabled={pending} onClick={rerun}>
          {pending ? <Spinner /> : <RotateCcw />}
          {t("rerun")}
        </Button>
      )}
    </>
  );
}
