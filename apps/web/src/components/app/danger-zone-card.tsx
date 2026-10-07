"use client";

import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmDialog } from "./confirm-dialog";

/** Delete card at the end of an edit form, in the form-section family with a destructive accent. */
export function DangerZoneCard({
  id,
  title,
  description,
  confirmTitle,
  confirmDescription,
  deleting,
  onDelete,
}: {
  /** Prefix of the heading id, e.g. "skill" for `skill-danger-title`. */
  id: string;
  title: string;
  description: string;
  confirmTitle: string;
  confirmDescription: string;
  deleting: boolean;
  onDelete: () => void;
}) {
  const tc = useTranslations("common.actions");

  return (
    <section
      aria-labelledby={`${id}-danger-title`}
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-destructive/25 bg-destructive/[0.03] px-4 py-3.5 sm:flex-nowrap sm:px-5 dark:bg-destructive/[0.06]"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
        <Trash2 className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 basis-48 space-y-0.5">
        <h2 id={`${id}-danger-title`} className="text-base leading-snug font-semibold tracking-tight">
          {title}
        </h2>
        <p className="text-sm text-pretty text-muted-foreground">{description}</p>
      </div>
      <ConfirmDialog
        trigger={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={deleting}
            className="ml-11 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive sm:ml-0"
          >
            {deleting ? <Spinner /> : <Trash2 />} {tc("delete")}
          </Button>
        }
        title={confirmTitle}
        description={confirmDescription}
        titleClassName="wrap-anywhere"
        confirm={tc("delete")}
        destructive
        onConfirm={onDelete}
      />
    </section>
  );
}
