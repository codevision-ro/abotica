"use client";

import { CircleCheck, Save, Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { UnsavedChangesGuard } from "@/components/app/unsaved-changes-guard";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/** How long the bar says "Saved" after a save, before it goes away. */
const SAVED_MS = 2000;

type FormState = { dirty: boolean; invalid: boolean; pending: boolean; onSave: () => void; onReset: () => void };

/**
 * The forms of the settings page on screen, by id. A page can hold several (System saves the sandbox,
 * the preview links and how much runs at once, each its own settings domain); they share one bar.
 */
const forms = new Map<string, FormState>();
const listeners = new Set<() => void>();
let version = 0;

function publish() {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * One form's part in the page's save bar: it registers what the form has changed and how to save or
 * discard it; the bar itself (SettingsSaveBarHost, in the settings layout) shows once any form changes.
 */
export function SettingsSaveBar({ dirty, invalid, pending, onSave, onReset }: FormState) {
  const id = useId();
  // The latest callbacks, so the bar never calls the ones of an older render.
  const actions = useRef({ onSave, onReset });
  useEffect(() => {
    actions.current = { onSave, onReset };
  });
  useEffect(() => {
    forms.set(id, {
      dirty,
      invalid,
      pending,
      onSave: () => actions.current.onSave(),
      onReset: () => actions.current.onReset(),
    });
    publish();
  }, [id, dirty, invalid, pending]);
  useEffect(
    () => () => {
      forms.delete(id);
      publish();
    },
    [id],
  );
  return null;
}

/**
 * The one primary action of a settings page: a bar pinned to the bottom of the content that appears with
 * the first change ("Unsaved changes", Discard, Save), saves every changed form of the page and asks
 * before leaving with changes unsaved. A save that leaves the page clean is confirmed in the bar itself,
 * so no toast covers its buttons.
 */
export function SettingsSaveBarHost() {
  const t = useTranslations("settings.form");
  const tc = useTranslations("common.actions");
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  const all = [...forms.values()];
  const changed = all.filter((form) => form.dirty);
  const dirty = changed.length > 0;
  const invalid = changed.some((form) => form.invalid);
  const pending = all.some((form) => form.pending);

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

  return (
    <>
      <UnsavedChangesGuard dirty={dirty} />
      <div
        aria-hidden={!visible}
        className={cn(
          "transition-all duration-200",
          visible
            ? "pointer-events-auto translate-y-0 opacity-100"
            : "pointer-events-none invisible translate-y-3 opacity-0",
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => changed.forEach((form) => form.onReset())}
                disabled={pending}
                tabIndex={dirty ? 0 : -1}
              >
                <Undo2 /> <span className="max-sm:sr-only">{t("discard")}</span>
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => changed.forEach((form) => form.onSave())}
                disabled={pending || invalid}
                tabIndex={dirty ? 0 : -1}
              >
                {pending ? <Spinner /> : <Save />} {tc("save")}
              </Button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
