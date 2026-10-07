"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { restoreSkillVersion } from "@/server/actions/skills";

export function RestoreSkillVersionButton({ id, version }: { id: string; version: number }) {
  const t = useTranslations("skills.versions");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm" disabled={pending}>
          {pending && <Spinner />} {t("restore")}
        </Button>
      }
      title={t("restoreTitle", { version })}
      description={t("restoreDescription", { version })}
      confirm={t("restore")}
      onConfirm={() =>
        startTransition(async () => {
          const res = await restoreSkillVersion({ id, version });
          if (!res.ok) return void toast.error(res.error);
          toast.success(t("restored", { version: res.data.version }));
          router.push(`/skills/${id}?tab=versions`, { scroll: false });
        })
      }
    />
  );
}
