"use client";

import { MAX_WAKES_PER_HOUR, type WakeupView, wakeupCondition } from "@abotica/core/wakeup-rules";
import { HourglassIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { SectionCard, SectionList } from "@/components/app/section-card";
import { type Tone, ToneBadge, useStatusLabels } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { useFormat } from "@/hooks/use-format";
import { cancelTaskWakeup } from "@/server/actions/tasks";

const TONE: Record<Exclude<WakeupView["status"], "fired">, Tone> = {
  active: "primary",
  paused: "warning",
  expired: "muted",
};

/**
 * What the task waits for (its agent's task_wait), so the user sees why it stays in progress, and the
 * waits a runaway limit or an expiry stopped. Each can be cancelled, or removed once stopped.
 */
export function TaskWakeups({ taskId, wakeups, className }: { taskId: string; wakeups: WakeupView[]; className?: string }) {
  const t = useTranslations("tasks.wakeups");
  const labels = useStatusLabels();
  const fmt = useFormat();
  const [pending, startTransition] = useTransition();

  function cancel(wakeup: WakeupView) {
    startTransition(async () => {
      const res = await cancelTaskWakeup({ taskId, id: wakeup.id });
      if (!res.ok) return void toast.error(res.error);
      toast.success(wakeup.status === "active" ? t("cancelled") : t("removed"));
    });
  }

  if (!wakeups.length) return null;
  return (
    <SectionCard icon={HourglassIcon} title={t("title")} count={wakeups.length} className={className} flush>
      <SectionList>
        {wakeups.map((w) => {
          if (w.status === "fired") return null;
          const condition = wakeupCondition(w, { time: (date) => fmt.dateTime(date), status: labels.task });
          const text = t(`condition.${condition.key}`, condition.values);
          const details =
            w.status === "paused" && w.pausedReason
              ? [t(`stopped.${w.pausedReason}`, { maxFires: w.maxFires, max: MAX_WAKES_PER_HOUR })]
              : w.status === "expired"
                ? [t("stopped.expired")]
                : [
                    w.maxFires > 1 ? t("fires", { fires: w.fires, maxFires: w.maxFires }) : null,
                    w.expiresAt ? t("expires", { time: fmt.dateTime(w.expiresAt) }) : null,
                  ].filter((line) => line !== null);
          const action = w.status === "active" ? t("cancel") : t("remove");
          return (
            <li key={w.id} className="flex min-w-0 items-start gap-3 px-4 py-2.5 sm:px-5">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium wrap-anywhere">
                  {w.pullRequest ? (
                    <a href={w.pullRequest.url} target="_blank" rel="noreferrer" className="hover:underline">
                      {text}
                    </a>
                  ) : (
                    text
                  )}
                </p>
                {details.length > 0 && <p className="text-xs text-muted-foreground">{details.join(" · ")}</p>}
                {w.notes && (
                  <p className="line-clamp-3 text-xs text-muted-foreground wrap-anywhere" title={w.notes}>
                    {t("notes", { notes: w.notes })}
                  </p>
                )}
              </div>
              <ToneBadge tone={TONE[w.status]}>{t(`status.${w.status}`)}</ToneBadge>
              <Button
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground"
                aria-label={action}
                title={action}
                disabled={pending}
                onClick={() => cancel(w)}
              >
                <XIcon />
              </Button>
            </li>
          );
        })}
      </SectionList>
    </SectionCard>
  );
}
