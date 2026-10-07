"use client";

import { ArchiveIcon, ArchiveRestoreIcon, RotateCcwIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { deleteProject, resetProjectWorkspace, setProjectStatus } from "@/server/actions/projects";

export function ProjectDangerZone({ projectId, name, archived }: { projectId: string; name: string; archived: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const t = useTranslations("projects.dangerZone");
  const ts = useTranslations("sandbox.project");
  const tc = useTranslations("common");

  function toggleArchive() {
    startTransition(async () => {
      const res = await setProjectStatus({ id: projectId, status: archived ? "active" : "archived" });
      if (!res.ok) return void toast.error(res.error);
      toast.success(archived ? t("restored") : t("archived"));
    });
  }

  function resetWorkspace() {
    startTransition(async () => {
      const res = await resetProjectWorkspace({ id: projectId });
      if (!res.ok) return void toast.error(res.error);
      toast.success(ts("resetDone"));
    });
  }

  function remove() {
    startTransition(async () => {
      const res = await deleteProject({ id: projectId });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("deleted"));
      // Replace, not push: Back must not lead to the settings of the deleted project.
      router.replace("/projects");
    });
  }

  return (
    <section
      aria-labelledby="project-danger-title"
      className="rounded-2xl border border-destructive/25 bg-card/70 shadow-[0_1px_2px_rgb(0_0_0/0.03)] dark:border-destructive/20 dark:bg-card/40"
    >
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/8 text-destructive dark:bg-destructive/15">
          <TriangleAlertIcon className="size-4" aria-hidden />
        </span>
        <h2 id="project-danger-title" className="text-base leading-snug font-semibold tracking-tight text-destructive">
          {t("title")}
        </h2>
      </div>
      <div aria-hidden className="h-px bg-linear-to-r from-destructive/25 via-destructive/10 to-transparent" />
      <div className="divide-y divide-border/70">
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium">{archived ? t("restoreTitle") : t("archiveTitle")}</p>
            <p className="text-sm text-pretty text-muted-foreground">
              {archived ? t("restoreDescription") : t("archiveDescription")}
            </p>
          </div>
          <Button variant="outline" onClick={toggleArchive} disabled={pending} className="shrink-0 self-start sm:self-auto">
            {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
            {archived ? t("restore") : t("archive")}
          </Button>
        </div>
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium">{ts("resetTitle")}</p>
            <p className="text-sm text-pretty text-muted-foreground">{ts("resetDescription")}</p>
          </div>
          <ConfirmDialog
            trigger={
              <Button variant="outline" disabled={pending} className="shrink-0 self-start sm:self-auto">
                <RotateCcwIcon />
                {ts("reset")}
              </Button>
            }
            title={ts("resetConfirmTitle", { name })}
            description={ts("resetConfirmDescription")}
            titleClassName="break-words"
            confirm={ts("resetConfirm")}
            destructive
            onConfirm={resetWorkspace}
          />
        </div>
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium">{t("deleteTitle")}</p>
            <p className="text-sm text-pretty text-muted-foreground">{t("deleteDescription")}</p>
          </div>
          <ConfirmDialog
            trigger={
              <Button variant="destructive" disabled={pending} className="shrink-0 self-start sm:self-auto">
                {pending ? <Spinner /> : <Trash2Icon />}
                {tc("actions.delete")}
              </Button>
            }
            title={t("confirmTitle", { name })}
            description={t("confirmDescription")}
            titleClassName="break-words"
            confirm={t("confirm")}
            destructive
            onConfirm={remove}
          />
        </div>
      </div>
    </section>
  );
}
