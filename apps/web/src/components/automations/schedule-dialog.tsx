"use client";

import type { AgentAvatar } from "@abotica/db/avatar";
import { isValidCron } from "@abotica/core/cron";
import { CalendarClockIcon, CalendarDaysIcon, PlusIcon, RepeatIcon, SaveIcon, TriangleAlertIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { OptionCards } from "@/components/app/option-cards";
import { chipVariants } from "@/components/app/selectable-chip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { createSchedule, updateSchedule } from "@/server/actions/automations";
import { CRON_PRESETS, type CronTranslator, describeCron } from "./cron";
import { DialogActiveSwitch, DialogGroup, DialogHeading, stickyFooterClass } from "./dialog-parts";
import { nextRun } from "./next-run";
import { AgentSelect, ProjectSelect } from "./option-selects";
import { dateToZonedLocal, formatInZone, isTimeZone } from "@/lib/time-zone";

type Option = { id: string; name: string; avatar?: AgentAvatar | null };

export type ScheduleDraft = {
  id?: string;
  name: string;
  agentId: string;
  projectId: string | null;
  kind: "cron" | "once";
  cron: string | null;
  runAt: Date | null;
  timezone: string;
  prompt: string;
  enabled: boolean;
};

export function ScheduleDialog({
  open,
  onOpenChange,
  initial,
  agents,
  projects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: ScheduleDraft;
  agents: Option[];
  projects: Option[];
}) {
  const edited = useRef(false);
  useEffect(() => {
    if (open) edited.current = false;
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        // A stray tap next to the dialog must not throw away typed text; Escape and the close button still work.
        onInteractOutside={(e) => edited.current && e.preventDefault()}
      >
        {open && (
          <ScheduleForm
            initial={initial}
            agents={agents}
            projects={projects}
            onEdit={() => (edited.current = true)}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ScheduleForm({
  initial,
  agents,
  projects,
  onEdit,
  onDone,
}: {
  initial: ScheduleDraft;
  agents: Option[];
  projects: Option[];
  onEdit: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("automations.scheduleDialog");
  const tf = useTranslations("automations.fields");
  const tc: CronTranslator = useTranslations("automations.cron");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const [name, setName] = useState(initial.name);
  const [agentId, setAgentId] = useState(initial.agentId);
  const [projectId, setProjectId] = useState(initial.projectId);
  const [kind, setKind] = useState(initial.kind);
  const [cron, setCron] = useState(initial.cron ?? "0 9 * * *");
  const [timezone, setTimezone] = useState(initial.timezone);
  const [runAt, setRunAt] = useState(initial.runAt ? dateToZonedLocal(initial.runAt, initial.timezone) : "");
  const [prompt, setPrompt] = useState(initial.prompt);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [pending, startTransition] = useTransition();

  const cronValid = isValidCron(cron);
  const tz = timezone.trim();
  const tzValid = isTimeZone(tz);
  const next = cronValid && tzValid ? nextRun({ kind: "cron", cron, runAt: null, timezone: tz }, new Date()) : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const input = {
        name,
        agentId,
        projectId,
        kind,
        cron: kind === "cron" ? cron : null,
        runAt: kind === "once" ? runAt : null,
        timezone: tz,
        prompt,
        enabled,
      };
      const res = initial.id ? await updateSchedule({ ...input, id: initial.id }) : await createSchedule(input);
      if (!res.ok) return void toast.error(res.error);
      toast.success(initial.id ? t("updated") : t("created"));
      onDone();
    });
  };

  const timezoneField = (
    <Field data-invalid={!tzValid || undefined}>
      <FieldLabel htmlFor="schedule-tz">{t("timezone")}</FieldLabel>
      <Input
        id="schedule-tz"
        value={timezone}
        onChange={(e) => setTimezone(e.target.value)}
        aria-invalid={!tzValid}
        placeholder="Europe/Bucharest"
      />
      {/* Recurring schedules show this in the preview below instead. */}
      {!tzValid && kind === "once" && <FieldError>{t("timezoneInvalid")}</FieldError>}
    </Field>
  );

  return (
    <form onSubmit={submit} onInput={onEdit} className="flex min-w-0 flex-col gap-5">
      <DialogHeading
        icon={CalendarClockIcon}
        title={initial.id ? t("editTitle") : t("createTitle")}
        description={t("description")}
      />

      <DialogGroup>
        <Field>
          <FieldLabel htmlFor="schedule-name">{tf("name")}</FieldLabel>
          <Input
            id="schedule-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")}
            required
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="schedule-agent">{tf("agent")}</FieldLabel>
            <AgentSelect id="schedule-agent" value={agentId} onChange={setAgentId} agents={agents} />
          </Field>
          <Field>
            <FieldLabel htmlFor="schedule-project">{tf("projectOptional")}</FieldLabel>
            <ProjectSelect id="schedule-project" value={projectId} onChange={setProjectId} projects={projects} />
          </Field>
        </div>
      </DialogGroup>

      <DialogGroup title={t("when")}>
        <OptionCards
          name="schedule-kind"
          label={t("kindAria")}
          value={kind}
          onValueChange={setKind}
          options={[
            { value: "cron", icon: RepeatIcon, title: t("kindCron") },
            { value: "once", icon: CalendarDaysIcon, title: t("kindOnce") },
          ]}
        />
        {kind === "cron" ? (
          <>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t("presets")}>
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.cron}
                  type="button"
                  aria-pressed={cron === p.cron}
                  onClick={() => setCron(p.cron)}
                  className={chipVariants({ selected: cron === p.cron, className: "h-7 px-2.5 text-xs" })}
                >
                  {tc(`presets.${p.key}`)}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_13rem]">
              <Field data-invalid={!cronValid || undefined}>
                <FieldLabel htmlFor="schedule-cron">{t("cron")}</FieldLabel>
                <Input
                  id="schedule-cron"
                  className="font-mono"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  aria-invalid={!cronValid}
                  aria-describedby="schedule-cron-preview"
                  placeholder="0 9 * * 1-5"
                />
              </Field>
              {timezoneField}
            </div>
            <div
              id="schedule-cron-preview"
              aria-live="polite"
              className="flex items-center gap-3 rounded-xl border bg-muted/30 px-3 py-2.5 dark:bg-input/10"
            >
              {cronValid && tzValid ? (
                <>
                  <RepeatIcon className="size-4 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{describeCron(cron, tc, locale)}</p>
                    {next && (
                      <p className="text-xs text-muted-foreground">
                        {t("nextRun", { date: formatInZone(next, tz, locale) })}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <TriangleAlertIcon className="size-4 shrink-0 text-destructive" aria-hidden />
                  <p className="min-w-0 flex-1 text-sm text-destructive">
                    {cronValid ? t("timezoneInvalid") : t("cronInvalid")}
                  </p>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_13rem]">
            <Field>
              <FieldLabel htmlFor="schedule-run-at">{t("runAt")}</FieldLabel>
              <Input
                id="schedule-run-at"
                type="datetime-local"
                value={runAt}
                onChange={(e) => setRunAt(e.target.value)}
                required
              />
            </Field>
            {timezoneField}
          </div>
        )}
      </DialogGroup>

      <DialogGroup title={tf("prompt")}>
        <Textarea
          id="schedule-prompt"
          aria-label={tf("prompt")}
          rows={5}
          className="max-h-72"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("promptPlaceholder")}
          required
        />
      </DialogGroup>

      <DialogFooter className={stickyFooterClass}>
        <DialogActiveSwitch id="schedule-enabled" label={t("enabled")} checked={enabled} onCheckedChange={setEnabled} />
        <Button
          type="submit"
          disabled={
            pending || !name.trim() || !agentId || !prompt.trim() || !tzValid || (kind === "cron" ? !cronValid : !runAt)
          }
        >
          {pending ? <Spinner /> : initial.id ? <SaveIcon /> : <PlusIcon />}
          {initial.id ? tCommon("actions.save") : t("create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
