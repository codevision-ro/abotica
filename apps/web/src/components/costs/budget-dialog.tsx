"use client";

import { type BudgetSettings, SETTINGS_LIMITS } from "@abotica/core/settings";
import { PencilIcon, PlusIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { chipVariants } from "@/components/app/selectable-chip";
import { SettingsNumberField } from "@/components/settings/settings-number-field";
import { useSettingsForm } from "@/components/settings/use-settings-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

const L = SETTINGS_LIMITS.budget;

/**
 * The monthly limit across all projects and the shares of it that send a warning, edited in a dialog
 * from the Costs page's budget card.
 */
export function BudgetDialog({ initial }: { initial: BudgetSettings }) {
  const t = useTranslations("costs.budgetDialog");
  const tc = useTranslations("common.actions");
  const [open, setOpen] = useState(false);
  const form = useSettingsForm("budget", initial, { onSaved: () => setOpen(false) });
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

  // Closing without saving drops what was typed, so the dialog opens on the stored budget next time.
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      form.reset();
      setDraft("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <PencilIcon /> <span className="max-sm:sr-only">{initial.monthlyUsd === null ? t("set") : t("edit")}</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
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
          <FieldSeparator />
          <Field>
            <FieldLabel htmlFor="budget-new-alert">{t("alertsTitle")}</FieldLabel>
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
                      id="budget-new-alert"
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
          </Field>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {tc("cancel")}
          </Button>
          <Button type="button" onClick={form.save} disabled={!form.dirty || form.invalid || form.pending}>
            {form.pending && <Spinner />} {tc("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
