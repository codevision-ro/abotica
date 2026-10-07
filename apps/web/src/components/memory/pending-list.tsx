"use client";

import { Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { approveMemories, rejectMemories } from "@/server/actions/memory";
import { type MemoryListItem, MemoryMeta, MemoryOwnerMedia, rowActionsClass } from "./memory-list";
import { MemoryPanel } from "./memory-panel";

/** The review queue: pick entries (or none for all), then approve them with the one primary button. */
export function PendingList({ items }: { items: MemoryListItem[] }) {
  const t = useTranslations("memory.pending");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const ids = items.map((m) => m.id);
  const chosen = ids.filter((id) => selected.has(id));
  const allChecked = chosen.length === ids.length && ids.length > 0;

  const run = (kind: "approve" | "reject", target: string[]) =>
    startTransition(async () => {
      const res = kind === "approve" ? await approveMemories({ ids: target }) : await rejectMemories({ ids: target });
      if (!res.ok) return void toast.error(res.error);
      toast.success(
        kind === "approve" ? t("approved", { count: res.data.count }) : t("rejected", { count: res.data.count }),
      );
      setSelected((prev) => new Set([...prev].filter((id) => !target.includes(id))));
    });

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <MemoryPanel
      description={
        <label className="flex w-fit cursor-pointer items-center gap-3 text-sm font-medium text-foreground">
          {/* Lines up with the row checkboxes below. */}
          <span className="flex size-8 items-center justify-center">
            <Checkbox
              checked={allChecked ? true : chosen.length ? "indeterminate" : false}
              onCheckedChange={(v) => setSelected(v === true ? new Set(ids) : new Set())}
              aria-label={t("selectAll")}
            />
          </span>
          {chosen.length ? t("selected", { count: chosen.length }) : t("selectAll")}
        </label>
      }
      action={
        <>
          {chosen.length > 0 && (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="outline" disabled={pending} className="max-sm:flex-1">
                  <X /> {t("reject")}
                </Button>
              }
              title={t("rejectTitle", { count: chosen.length })}
              description={t("rejectDescription")}
              confirm={t("reject")}
              destructive
              onConfirm={() => run("reject", chosen)}
            />
          )}
          <Button
            size="sm"
            disabled={pending}
            onClick={() => run("approve", chosen.length ? chosen : ids)}
            className="max-sm:flex-1"
          >
            {pending ? <Spinner /> : <Check />} {chosen.length ? t("approveSelected") : t("approveAll")}
          </Button>
        </>
      }
    >
      <ul className="divide-y divide-border/60">
        {items.map((m) => {
          const on = selected.has(m.id);
          return (
            <li
              key={m.id}
              className={cn(
                "group/row flex min-w-0 items-center gap-3 px-4 py-3 transition-colors sm:px-5",
                on ? "bg-primary/5" : "hover:bg-muted/30",
              )}
            >
              {/* The padded label gives the 16px checkbox a finger-sized hit area. */}
              <label className="flex size-8 shrink-0 cursor-pointer items-center justify-center">
                <Checkbox checked={on} onCheckedChange={(v) => toggle(m.id, v === true)} aria-label={t("selectMemory")} />
              </label>
              <MemoryOwnerMedia m={m} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">{m.content}</p>
                <MemoryMeta m={m} showScope showOwner showStatus={false} />
              </div>
              <div className={rowActionsClass}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("rejectMemory")}
                  title={t("rejectMemory")}
                  disabled={pending}
                  onClick={() => run("reject", [m.id])}
                  className="hover:text-destructive"
                >
                  <X />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("approveMemory")}
                  title={t("approveMemory")}
                  disabled={pending}
                  onClick={() => run("approve", [m.id])}
                  className="hover:bg-success/10 hover:text-success"
                >
                  <Check />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </MemoryPanel>
  );
}
