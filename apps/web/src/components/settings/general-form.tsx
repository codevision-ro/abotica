"use client";

import type { AppSettings } from "@abotica/core/settings";
import { Bot, CalendarClock, Save, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormSection } from "@/components/app/form-section";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { updateAppSettings } from "@/server/actions/settings";

/** Same as RUN_CONCURRENCY_MAX in core, which a client component cannot import. */
const RUN_CONCURRENCY_MAX = 20;

const TIMEZONES = [
  "Europe/Bucharest",
  "Europe/Chisinau",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Athens",
  "Europe/Istanbul",
  "Europe/Kyiv",
  "Europe/Moscow",
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export function GeneralSettingsForm({ initial }: { initial: AppSettings }) {
  const t = useTranslations("settings.general");
  const tc = useTranslations("common.actions");
  const router = useRouter();
  const [journalDays, setJournalDays] = useState(String(initial.journalDays));
  const [parallelDelegations, setParallelDelegations] = useState(String(initial.parallelDelegations));
  const [runConcurrency, setRunConcurrency] = useState(String(initial.runConcurrency));
  const [memoryRequiresApproval, setMemoryRequiresApproval] = useState(initial.memoryRequiresApproval);
  const [pinnedTokens, setPinnedTokens] = useState(String(initial.memoryPinnedTokens));
  const [recallTokens, setRecallTokens] = useState(String(initial.memoryRecallTokens));
  const [digestHour, setDigestHour] = useState(String(initial.digestHour));
  const [timezone, setTimezone] = useState(initial.timezone);
  const [budget, setBudget] = useState(initial.monthlyBudgetUsd === null ? "" : String(initial.monthlyBudgetUsd));
  const [pending, startTransition] = useTransition();
  const timezones = TIMEZONES.includes(initial.timezone) ? TIMEZONES : [initial.timezone, ...TIMEZONES];

  const days = Number(journalDays);
  const daysInvalid = !Number.isInteger(days) || days < 1 || days > 30;
  const parallel = Number(parallelDelegations);
  const parallelInvalid = !Number.isInteger(parallel) || parallel < 1 || parallel > 10;
  const concurrency = Number(runConcurrency);
  const concurrencyInvalid = !Number.isInteger(concurrency) || concurrency < 1 || concurrency > RUN_CONCURRENCY_MAX;
  const pinned = Number(pinnedTokens);
  const pinnedInvalid = pinnedTokens.trim() === "" || !Number.isInteger(pinned) || pinned < 0 || pinned > 20_000;
  const recall = Number(recallTokens);
  const recallInvalid = recallTokens.trim() === "" || !Number.isInteger(recall) || recall < 0 || recall > 8_000;
  const budgetValue = budget.trim() === "" ? null : Number(budget.replace(",", "."));
  const budgetInvalid = budgetValue !== null && (!Number.isFinite(budgetValue) || budgetValue <= 0);
  const invalid = daysInvalid || parallelInvalid || concurrencyInvalid || pinnedInvalid || recallInvalid || budgetInvalid;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (invalid) return;
    startTransition(async () => {
      const res = await updateAppSettings({
        journalDays: days,
        parallelDelegations: parallel,
        runConcurrency: concurrency,
        memoryRequiresApproval,
        memoryPinnedTokens: pinned,
        memoryRecallTokens: recall,
        digestHour: Number(digestHour),
        timezone,
        monthlyBudgetUsd: budgetValue,
      });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("saved"));
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <FormSection id="general-agents" icon={Bot} title={t("agentsTitle")} description={t("agentsDescription")}>
        <FieldGroup>
          <Field orientation="responsive" data-invalid={daysInvalid}>
            <FieldContent>
              <FieldLabel htmlFor="journal-days">{t("journalDays")}</FieldLabel>
              <FieldDescription>{t("journalDaysHint")}</FieldDescription>
            </FieldContent>
            <Input
              id="journal-days"
              type="number"
              inputMode="numeric"
              min={1}
              max={30}
              value={journalDays}
              onChange={(e) => setJournalDays(e.target.value)}
              aria-invalid={daysInvalid}
              className="sm:w-28"
            />
          </Field>
          <FieldSeparator />
          <Field orientation="responsive" data-invalid={parallelInvalid}>
            <FieldContent>
              <FieldLabel htmlFor="parallel-delegations">{t("parallelDelegations")}</FieldLabel>
              <FieldDescription>{t("parallelDelegationsHint")}</FieldDescription>
            </FieldContent>
            <Input
              id="parallel-delegations"
              type="number"
              inputMode="numeric"
              min={1}
              max={10}
              value={parallelDelegations}
              onChange={(e) => setParallelDelegations(e.target.value)}
              aria-invalid={parallelInvalid}
              className="sm:w-28"
            />
          </Field>
          <FieldSeparator />
          <Field orientation="responsive" data-invalid={concurrencyInvalid}>
            <FieldContent>
              <FieldLabel htmlFor="run-concurrency">{t("runConcurrency")}</FieldLabel>
              <FieldDescription>{t("runConcurrencyHint", { max: RUN_CONCURRENCY_MAX })}</FieldDescription>
            </FieldContent>
            <Input
              id="run-concurrency"
              type="number"
              inputMode="numeric"
              min={1}
              max={RUN_CONCURRENCY_MAX}
              value={runConcurrency}
              onChange={(e) => setRunConcurrency(e.target.value)}
              aria-invalid={concurrencyInvalid}
              className="sm:w-28"
            />
          </Field>
          <FieldSeparator />
          <Field orientation="responsive" data-invalid={pinnedInvalid}>
            <FieldContent>
              <FieldLabel htmlFor="memory-pinned-tokens">{t("memoryPinnedTokens")}</FieldLabel>
              <FieldDescription>{t("memoryPinnedTokensHint")}</FieldDescription>
            </FieldContent>
            <Input
              id="memory-pinned-tokens"
              type="number"
              inputMode="numeric"
              min={0}
              max={20_000}
              step={100}
              value={pinnedTokens}
              onChange={(e) => setPinnedTokens(e.target.value)}
              aria-invalid={pinnedInvalid}
              className="sm:w-28"
            />
          </Field>
          <FieldSeparator />
          <Field orientation="responsive" data-invalid={recallInvalid}>
            <FieldContent>
              <FieldLabel htmlFor="memory-recall-tokens">{t("memoryRecallTokens")}</FieldLabel>
              <FieldDescription>{t("memoryRecallTokensHint")}</FieldDescription>
            </FieldContent>
            <Input
              id="memory-recall-tokens"
              type="number"
              inputMode="numeric"
              min={0}
              max={8_000}
              step={100}
              value={recallTokens}
              onChange={(e) => setRecallTokens(e.target.value)}
              aria-invalid={recallInvalid}
              className="sm:w-28"
            />
          </Field>
          <FieldSeparator />
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="memory-approval">{t("memoryApproval")}</FieldLabel>
              <FieldDescription>{t("memoryApprovalHint")}</FieldDescription>
            </FieldContent>
            <Switch id="memory-approval" checked={memoryRequiresApproval} onCheckedChange={setMemoryRequiresApproval} />
          </Field>
        </FieldGroup>
      </FormSection>

      <FormSection id="general-digest" icon={CalendarClock} title={t("digestTitle")} description={t("digestDescription")}>
        <FieldGroup>
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel htmlFor="digest-hour">{t("digestHour")}</FieldLabel>
              <FieldDescription>{t("digestHourHint")}</FieldDescription>
            </FieldContent>
            <Select value={digestHour} onValueChange={setDigestHour}>
              <SelectTrigger id="digest-hour" className="sm:w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, h) => (
                  <SelectItem key={h} value={String(h)}>
                    {String(h).padStart(2, "0")}:00
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <FieldSeparator />
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel htmlFor="timezone">{t("timezone")}</FieldLabel>
              <FieldDescription>{t("timezoneHint")}</FieldDescription>
            </FieldContent>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id="timezone" className="sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {timezones.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
      </FormSection>

      <FormSection id="general-budget" icon={Wallet} title={t("budgetTitle")} description={t("budgetHint")}>
        <Field orientation="responsive" data-invalid={budgetInvalid}>
          <FieldContent>
            <FieldLabel htmlFor="monthly-budget">{t("budget")}</FieldLabel>
          </FieldContent>
          <Input
            id="monthly-budget"
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder={t("budgetPlaceholder")}
            aria-invalid={budgetInvalid}
            className="sm:w-28"
          />
        </Field>
      </FormSection>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending || invalid}>
          {pending ? <Spinner /> : <Save />} {tc("save")}
        </Button>
      </div>
    </form>
  );
}
