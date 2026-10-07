"use client";

import { BellRing } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { SectionIcon, sectionCardClass } from "@/components/app/section-card";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { setUpdateChecks } from "@/server/actions/updates";

/** Automatic checks on or off; saved as soon as it is flipped. */
export function UpdateChecksToggle({ initial }: { initial: boolean }) {
  const t = useTranslations("settings.updates");
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial);
  const [pending, startTransition] = useTransition();

  function change(next: boolean) {
    setEnabled(next);
    startTransition(async () => {
      const res = await setUpdateChecks({ enabled: next });
      if (!res.ok) {
        setEnabled(!next);
        return void toast.error(res.error);
      }
      toast.success(next ? t("autoOn") : t("autoOff"));
      router.refresh();
    });
  }

  return (
    <section
      aria-labelledby="update-checks-title"
      className={cn(sectionCardClass, "flex items-center gap-3 px-4 py-3.5 sm:px-5")}
    >
      <SectionIcon icon={BellRing} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <h2 id="update-checks-title" className="text-base leading-snug font-semibold tracking-tight">
          {t("autoTitle")}
        </h2>
        <p className="text-sm text-pretty text-muted-foreground">{t("autoDescription")}</p>
        <p className="text-xs text-pretty text-muted-foreground/80">{t("autoNote")}</p>
      </div>
      <Switch
        aria-labelledby="update-checks-title"
        checked={enabled}
        onCheckedChange={change}
        disabled={pending}
        className="ml-2"
      />
    </section>
  );
}
