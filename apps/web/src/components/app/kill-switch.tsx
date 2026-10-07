"use client";

import { OctagonX, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setKillSwitch } from "@/server/actions/system";

export function KillSwitch({ active }: { active: boolean }) {
  const [pending, start] = useTransition();
  const t = useTranslations("shell.killSwitch");
  const tCommon = useTranslations("common");
  const set = (value: boolean) =>
    start(async () => {
      const res = await setKillSwitch({ active: value });
      if (!res.ok) toast.error(res.error);
      else toast[value ? "warning" : "success"](value ? t("stopped") : t("resumed"));
    });

  if (active) {
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => set(false)}
        aria-label={t("resume")}
        className="h-9 border-destructive/30 bg-background text-destructive hover:bg-destructive/5 hover:text-destructive md:h-8 dark:border-destructive/40"
      >
        <Play /> <span className="hidden sm:inline">{t("resume")}</span>
        <span className="sm:hidden">{t("resumeShort")}</span>
      </Button>
    );
  }
  return (
    <AlertDialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertDialogTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              aria-label={t("stopAll")}
              className="group/stop h-9 min-w-9 text-muted-foreground hover:bg-destructive/8 hover:text-destructive md:h-8 dark:hover:bg-destructive/15"
            >
              <OctagonX className="text-destructive/80 group-hover/stop:text-destructive" />
              <span className="hidden sm:inline">{t("stop")}</span>
            </Button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("stopAll")}</TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="size-10 rounded-xl bg-destructive/10 text-destructive dark:bg-destructive/15">
            <OctagonX className="size-5" />
          </AlertDialogMedia>
          <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("confirmDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tCommon("actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => set(true)} className="bg-destructive text-white hover:bg-destructive/90">
            {t("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
