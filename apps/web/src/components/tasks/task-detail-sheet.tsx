"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { TaskDetailData, TaskOptions } from "@/server/queries/tasks";
import { TaskDetail } from "./task-detail";
import { useTaskParams } from "./task-meta";

/** Right-side sheet driven by ?task=<id>; the server page loads the detail for that id. */
export function TaskDetailSheet({ detail, options }: { detail: TaskDetailData | null; options: TaskOptions }) {
  const t = useTranslations("tasks");
  const { searchParams, closeOverlay } = useTaskParams();
  const open = !!detail && searchParams.get("task") === detail.id;
  // Keep the last task rendered while the close animation runs.
  const [shown, setShown] = useState(detail);
  if (detail && detail !== shown) setShown(detail);

  const task = detail ?? shown;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && closeOverlay({ task: null })}>
      <SheetContent
        className="w-full gap-0 overflow-y-auto bg-background p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          // Escape in a text field with content cancels that edit (title, description, comment), not the whole sheet.
          const el = document.activeElement;
          const text = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === "text");
          if (text && (el as HTMLInputElement).value) e.preventDefault();
        }}
      >
        <SheetTitle className="sr-only">{task?.title ?? t("meta.fallbackTitle")}</SheetTitle>
        <SheetDescription className="sr-only">{t("detail.sheetDescription")}</SheetDescription>
        {task && (
          <div className="p-4 pt-5 md:p-6">
            <TaskDetail key={task.id} task={task} options={options} mode="sheet" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
