"use client";

import { type BudgetSettings, SETTINGS_LIMITS } from "@abotica/core/settings";
import { BellRing, PlusIcon, Wallet, XIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormSection } from "@/components/app/form-section";
import { chipVariants } from "@/components/app/selectable-chip";
import { Button } from "@/components/ui/button";
import { FieldDescription, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SettingsNumberField } from "./settings-number-field";
import { SettingsSaveBar } from "./settings-save-bar";
import { useSettingsForm } from "./use-settings-form";

const L = SETTINGS_LIMITS.budget;

const costsLink = (chunks: React.ReactNode) => (
  <Link href="/costs" className="font-medium text-foreground underline underline-offset-2">
    {chunks}
  </Link>
);

/** Settings > Budget: the monthly limit across all projects and the percentages of it that send a warning. */
export function BudgetSettingsForm({ initial }: { initial: BudgetSettings }) {
  const t = useTranslations("settings.budget");
  const form = useSettingsForm("budget", initial);
  const { values, set, error, errorUnder } = form;
  const [draft, setDraft] = useState("");
  const percents = values.alertPercents;
  const typed = Number(draft.trim());
  const canAdd =
    percents.length < L.alerts.max &&
    Number.isInteger(typed) &&
    typed >= L.alertPercent.min &&
    typed <= L.alertPercent.max &&
    !percents.includes(typed);

  function add(e: React.FormEvent) {
    e.preventDefault();
    if (!canAdd) return;
    set({ alertPercents: [...percents, typed].sort((a, b) => a - b) });
    setDraft("");
  }

  return (
    <>
      <FormSection id="budget-monthly" icon={Wallet} title={t("monthlyTitle")} description={t("monthlyDescription")}>
        <SettingsNumberField
          id="budget-monthly-usd"
          nullable
          decimal
          label={t("monthly")}
          hint={t("monthlyHint")}
          value={values.monthlyUsd}
          onChange={(monthlyUsd) => set({ monthlyUsd })}
          error={error("monthlyUsd")}
          placeholder={t("noLimit")}
          unit="USD"
        />
        <FieldDescription>{t.rich("costsLink", { link: costsLink })}</FieldDescription>
      </FormSection>

      <FormSection id="budget-alerts" icon={BellRing} title={t("alertsTitle")} description={t("alertsDescription")}>
        <div className="flex flex-wrap items-center gap-2">
          {percents.map((percent) => (
            <span key={percent} className={chipVariants({ selected: true, className: "gap-1 pr-1" })}>
              <span className="tabular">{percent}%</span>
              <button
                type="button"
                onClick={() => set({ alertPercents: percents.filter((p) => p !== percent) })}
                aria-label={t("removeAlert", { percent })}
                className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <XIcon className="size-3.5" aria-hidden />
              </button>
            </span>
          ))}
          {percents.length < L.alerts.max && (
            <form onSubmit={add} className="flex items-center gap-1.5">
              <div className="relative">
                <Input
                  aria-label={t("newAlert")}
                  inputMode="numeric"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={t("newAlertPlaceholder")}
                  className="tabular h-8 w-24 rounded-full pr-7"
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                  %
                </span>
              </div>
              <Button type="submit" variant="outline" size="sm" className="rounded-full" disabled={!canAdd}>
                <PlusIcon /> {t("addAlert")}
              </Button>
            </form>
          )}
        </div>
        {errorUnder("alertPercents") && <FieldError>{errorUnder("alertPercents")}</FieldError>}
        <FieldDescription>
          {percents.length ? t("alertsHint", { ...L.alertPercent, count: L.alerts.max }) : t("alertsNone")}{" "}
          {t("alertsStop")}
        </FieldDescription>
      </FormSection>

      <SettingsSaveBar
        dirty={form.dirty}
        invalid={form.invalid}
        pending={form.pending}
        onSave={form.save}
        onReset={form.reset}
      />
    </>
  );
}
