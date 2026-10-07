"use client";

import type { AgentAvatar } from "@abotica/db/avatar";
import { CalendarClockIcon, CalendarDaysIcon, PauseIcon, PencilIcon, PlayIcon, PlusIcon, RepeatIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/app/relative-time";
import { ConfirmDelete } from "@/components/app/confirm-dialog";
import { sectionCardClass } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useFormat } from "@/hooks/use-format";
import { deleteSchedule, setScheduleEnabled, startScheduleRun } from "@/server/actions/automations";
import { AutomationCard, AutomationDetail, AutomationPrompt, automationGridClass } from "./automation-card";
import { type CronTranslator, describeCron } from "./cron";
import { nextRun } from "./next-run";
import { ScheduleDialog, type ScheduleDraft } from "./schedule-dialog";
import { formatInZone } from "@/lib/time-zone";

type Option = { id: string; name: string; avatar?: AgentAvatar | null };

type ScheduleItem = ScheduleDraft & {
  id: string;
  agentName: string;
  agentAvatar: AgentAvatar | null;
  projectName: string | null;
  lastRunAt: Date | null;
};

export function SchedulesSection({
  schedules,
  agents,
  projects,
  timezone,
  toolbar,
}: {
  schedules: ScheduleItem[];
  agents: Option[];
  projects: Option[];
  timezone: string;
  /** Shown left of the "New schedule" button, e.g. the page's tabs. */
  toolbar?: React.ReactNode;
}) {
  const t = useTranslations("automations.schedules");
  const [dialog, setDialog] = useState<{ open: boolean; draft: ScheduleDraft }>({
    open: false,
    draft: blank(agents, timezone),
  });
  const openNew = () => setDialog({ open: true, draft: blank(agents, timezone) });
  const newButton = (
    <Button onClick={openNew} disabled={!agents.length}>
      <PlusIcon /> {t("new")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {toolbar}
        <div className="ml-auto">{newButton}</div>
      </div>
      {schedules.length ? (
        <div className={automationGridClass}>
          {schedules.map((s) => (
            <ScheduleCard key={s.id} s={s} onEdit={() => setDialog({ open: true, draft: s })} />
          ))}
        </div>
      ) : (
        <p className={cn(sectionCardClass, "px-4 py-4 text-sm text-muted-foreground sm:px-5")}>{t("empty")}</p>
      )}
      <ScheduleDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        initial={dialog.draft}
        agents={agents}
        projects={projects}
      />
    </div>
  );
}

function blank(agents: Option[], timezone: string): ScheduleDraft {
  return {
    name: "",
    agentId: agents[0]?.id ?? "",
    projectId: null,
    kind: "cron",
    cron: "0 9 * * *",
    runAt: null,
    timezone,
    prompt: "",
    enabled: true,
  };
}

/** Readable "when" for a schedule, in the current language. */
function useScheduleWhen() {
  const t = useTranslations("automations.schedules");
  const tc: CronTranslator = useTranslations("automations.cron");
  const locale = useLocale();
  return (s: ScheduleItem) =>
    s.kind === "cron"
      ? describeCron(s.cron, tc, locale)
      : s.runAt
        ? t("once", { date: formatInZone(s.runAt, s.timezone, locale) })
        : t("noDate");
}

function ScheduleSwitch({ s }: { s: ScheduleItem }) {
  const t = useTranslations("automations.schedules");
  const [pending, startTransition] = useTransition();
  return (
    <Switch
      checked={s.enabled}
      disabled={pending}
      aria-label={s.enabled ? t("disable") : t("enable")}
      onCheckedChange={(enabled) =>
        startTransition(async () => {
          const res = await setScheduleEnabled({ id: s.id, enabled });
          if (!res.ok) toast.error(res.error);
        })
      }
    />
  );
}

/** Icon button with its label in a tooltip. */
function IconAction({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ScheduleActions({ s, onEdit }: { s: ScheduleItem; onEdit: () => void }) {
  const t = useTranslations("automations.schedules");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="relative z-10 ml-auto flex gap-0.5">
      <IconAction label={t("runNow")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("runNow")}
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await startScheduleRun({ id: s.id });
              if (!res.ok) return void toast.error(res.error);
              toast.success(t("runStarted"), {
                action: { label: t("viewRun"), onClick: () => router.push(`/runs/${res.data.runId}`) },
              });
            })
          }
        >
          <PlayIcon />
        </Button>
      </IconAction>
      <IconAction label={t("edit")}>
        <Button variant="ghost" size="icon-sm" aria-label={t("edit")} onClick={onEdit}>
          <PencilIcon />
        </Button>
      </IconAction>
      <ConfirmDelete
        label={t("delete")}
        title={t("deleteTitle")}
        description={t("deleteDescription", { name: s.name })}
        onConfirm={async () => {
          const res = await deleteSchedule({ id: s.id });
          if (res.ok) toast.success(t("deleted"));
          else toast.error(res.error);
        }}
      />
    </div>
  );
}

/** When the schedule fires next; computed after mount so server and browser clocks cannot disagree. */
function NextRun({ s }: { s: ScheduleItem }) {
  const t = useTranslations("automations.schedules");
  const f = useFormat();
  const [next, setNext] = useState<Date | null | undefined>(undefined);
  useEffect(() => {
    const update = () => setNext(nextRun(s, new Date()));
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, [s]);

  if (!s.enabled) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <PauseIcon className="size-3.5" aria-hidden /> {t("paused")}
      </span>
    );
  }
  if (!next) return null;
  return (
    <span className="inline-flex items-center gap-1.5 font-medium" title={f.dateTime(next)}>
      <CalendarClockIcon className="size-3.5 text-primary" aria-hidden />
      <span>{t.rich("nextRun", { time: () => <RelativeTime date={next} /> })}</span>
    </span>
  );
}

function ScheduleCard({ s, onEdit }: { s: ScheduleItem; onEdit: () => void }) {
  const t = useTranslations("automations.schedules");
  const scheduleWhen = useScheduleWhen();
  return (
    <AutomationCard
      name={s.name}
      agentName={s.agentName}
      agentAvatar={s.agentAvatar}
      projectName={s.projectName}
      enabled={s.enabled}
      editLabel={t("edit")}
      onEdit={onEdit}
      toggle={<ScheduleSwitch s={s} />}
      footer={
        <>
          <div className="flex min-w-0 flex-col gap-0.5 text-xs">
            <NextRun s={s} />
            <span className="truncate text-muted-foreground">
              {s.lastRunAt ? t.rich("lastRunAgo", { time: () => <RelativeTime date={s.lastRunAt!} /> }) : t("notRunYet")}
            </span>
          </div>
          <ScheduleActions s={s} onEdit={onEdit} />
        </>
      }
    >
      <AutomationDetail
        icon={s.kind === "cron" ? RepeatIcon : CalendarDaysIcon}
        title={<span title={scheduleWhen(s)}>{scheduleWhen(s)}</span>}
        meta={<span className="font-mono">{s.kind === "cron" ? `${s.cron} · ${s.timezone}` : s.timezone}</span>}
      />
      <AutomationPrompt prompt={s.prompt} />
    </AutomationCard>
  );
}
