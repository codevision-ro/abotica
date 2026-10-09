"use client";

import {
  type AppSettings,
  mergeSettings,
  SETTINGS_SCHEMAS,
  type SettingsDomain,
  settingsIssueValues,
  type SettingsPatch,
} from "@abotica/core/settings";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useDirtySnapshot } from "@/hooks/use-dirty-snapshot";
import { saveSettings } from "@/server/actions/app-settings";

type SaveResult<T> = { ok: true; data: T } | { ok: false; error: string };

type SettingsFormOptions<D extends SettingsDomain> = {
  /**
   * Saves the changed fields instead of saveSettings, for a form that holds fields with their own action
   * (the default models); `values` is the whole validated domain. Returns the domain as stored.
   */
  submit?: (patch: SettingsPatch<AppSettings[D]>, values: AppSettings[D]) => Promise<SaveResult<AppSettings[D]>>;
};

/**
 * State of one settings domain's form: the values, what changed since the last save, the problems the
 * shared schema finds (translated, by dotted path) and the save, which sends the changed fields.
 */
export function useSettingsForm<D extends SettingsDomain>(
  domain: D,
  initial: AppSettings[D],
  options: SettingsFormOptions<D> = {},
) {
  const t = useTranslations();
  const router = useRouter();
  const [values, setValues] = useState<AppSettings[D]>(initial);
  const [saved, setSaved] = useState<AppSettings[D]>(initial);
  const { dirty, markSaved } = useDirtySnapshot(values);
  const [pending, startTransition] = useTransition();

  const parsed = SETTINGS_SCHEMAS[domain].safeParse(values);
  const errors = new Map<string, string>();
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".");
      if (errors.has(path)) continue;
      const loose = t as unknown as { has(k: string): boolean; (k: string, v?: Record<string, unknown>): string };
      errors.set(path, loose.has(issue.message) ? loose(issue.message, settingsIssueValues(issue)) : issue.message);
    }
  }

  /** Changes some fields; nested objects may name only the fields that change. */
  const set = (patch: SettingsPatch<AppSettings[D]>) => setValues((current) => mergeSettings(current, patch));

  const save = () =>
    startTransition(async () => {
      if (!parsed.success) return;
      // Only the fields that changed: some fields of a domain are saved by their own action (OWN_ACTION).
      const data = parsed.data as Record<string, unknown>;
      const before = saved as Record<string, unknown>;
      const patch = Object.fromEntries(
        Object.entries(data).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])),
      );
      const res = options.submit
        ? await options.submit(patch as SettingsPatch<AppSettings[D]>, parsed.data as AppSettings[D])
        : await saveSettings({ domain, patch });
      if (!res.ok) return void toast.error(res.error);
      const next = res.data as AppSettings[D];
      setValues(next);
      setSaved(next);
      markSaved(next);
      router.refresh();
    });

  const reset = () => setValues(saved);

  return {
    values,
    set,
    dirty,
    invalid: !parsed.success,
    /** The translated problem of the field at `path` ("defaultLimits.maxSteps"), if any. */
    error: (path: string) => errors.get(path),
    /** The first problem at `path` or below it ("chains.agent" for "chains.agent.0.model"), if any. */
    errorUnder: (path: string) => [...errors].find(([key]) => key === path || key.startsWith(`${path}.`))?.[1],
    pending,
    save,
    reset,
  };
}

export type SettingsForm<D extends SettingsDomain> = ReturnType<typeof useSettingsForm<D>>;
