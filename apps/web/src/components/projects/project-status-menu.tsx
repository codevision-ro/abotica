"use client";

import { ChevronDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { setProjectStatus } from "@/server/actions/projects";
import { PROJECT_STATUSES, useProjectStatusLabel } from "./project-badges";

type Status = "active" | "paused" | "archived";

export function ProjectStatusMenu({ projectId, status }: { projectId: string; status: Status }) {
  const [pending, startTransition] = useTransition();
  const t = useTranslations("projects.status");
  const label = useProjectStatusLabel();

  function change(next: string) {
    if (next === status) return;
    startTransition(async () => {
      const res = await setProjectStatus({ id: projectId, status: next as Status });
      if (!res.ok) toast.error(res.error);
      else toast.success(t("changed", { status: label(next) }));
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={pending}>
          {pending && <Spinner />}
          {t("trigger")}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel>{t("menuLabel")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={status} onValueChange={change}>
          {PROJECT_STATUSES.map((s) => (
            <DropdownMenuRadioItem key={s} value={s}>
              {t(s)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
