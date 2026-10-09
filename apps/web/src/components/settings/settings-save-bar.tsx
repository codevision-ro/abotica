"use client";

import { CircleCheck, Save, Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { UnsavedChangesGuard } from "@/components/app/unsaved-changes-guard";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/** How long the bar says "Saved" after a save, before it goes away. */
const SAVED_MS = 2000;

/**
 * Where the bar goes: a zero-height sticky slot at the end of the settings content column (settings
 * layout). Sticky there, the bar stays at the bottom of the window, over the content column only, and takes
 * no room between the cards.
 */
export const SETTINGS_SAVE_SLOT_ID = "settings-save-slot";

const noSubscription = () => () => {};
const findSlot = () => document.getElementById(SETTINGS_SAVE_SLOT_ID);

/**
 * The one primary action of a settings page: a bar pinned to the bottom of the content that appears with
 * the first change ("Unsaved changes", Discard, Save) and asks before leaving with changes unsaved. A save
 * that leaves the form clean is confirmed in the bar itself, so no toast covers its buttons.
 */
export function SettingsSaveBar({
  dirty,
  invalid,
  pending,
  onSave,
  onReset,
}: {
  dirty: boolean;
  invalid: boolean;
  pending: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  const t = useTranslations("settings.form");
  const tc = useTranslations("common.actions");
  const [wasPending, setWasPending] = useState(pending);
  const [saved, setSaved] = useState(false);
  if (pending !== wasPending) {
    setWasPending(pending);
    setSaved(!pending && !dirty);
  }
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), SAVED_MS);
    return () => clearTimeout(timer);
  }, [saved]);
  const confirming = saved && !dirty;
  const visible = dirty || confirming;
  const slot = useSyncExternalStore(noSubscription, findSlot, () => null);
  const bar = (
    <div
      aria-hidden={!visible}
      className={cn(
        "transition-all duration-200",
        visible ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none invisible translate-y-3 opacity-0",
      )}
    >
      <div className="flex min-h-12 items-center gap-3 rounded-2xl border bg-background/90 px-4 py-2 shadow-lg backdrop-blur">
        {confirming ? (
          <span role="status" className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
            <CircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <span className="truncate">{t("saved")}</span>
          </span>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {invalid ? t("invalid") : t("unsaved")}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={onReset} disabled={pending} tabIndex={dirty ? 0 : -1}>
              <Undo2 /> <span className="max-sm:sr-only">{t("discard")}</span>
            </Button>
            <Button type="button" size="sm" onClick={onSave} disabled={pending || invalid} tabIndex={dirty ? 0 : -1}>
              {pending ? <Spinner /> : <Save />} {tc("save")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
  return (
    <>
      <UnsavedChangesGuard dirty={dirty} />
      {slot ? createPortal(bar, slot) : <div className="sticky bottom-4 z-30">{bar}</div>}
    </>
  );
}
