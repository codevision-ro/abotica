"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { checkUpdatesNow } from "@/server/actions/updates";

/** The page's primary action: ask GitHub now, even with automatic checks off. */
export function UpdateCheckButton() {
  const t = useTranslations("settings.updates");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function check() {
    startTransition(async () => {
      const res = await checkUpdatesNow({});
      if (!res.ok) return void toast.error(t("result.failed"), { description: res.error });
      const { current, latest, available, error } = res.data;
      if (error) toast.error(t("result.failed"), { description: error });
      else if (!latest) toast.info(t("result.none"));
      else if (available) toast.success(t("result.available", { version: `v${latest.version}` }));
      else if (current) toast.success(t("result.upToDate", { version: `v${current}` }));
      else toast.info(t("result.source", { version: `v${latest.version}` }));
      router.refresh();
    });
  }

  return (
    <Button onClick={check} disabled={pending}>
      {pending ? <Spinner /> : <RefreshCw />} {t("checkNow")}
    </Button>
  );
}
