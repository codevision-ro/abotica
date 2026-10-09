import type { OfficeActivity, OfficeInteractionKind, OfficeSeat, OfficeStatus } from "@abotica/core/office";
import { useTranslations } from "next-intl";
import { type Tone, ToneBadge } from "@/components/app/status-badge";

/** Same tones as the run and task badges: a running run is primary, an approval waits in warning. */
const STATUS_TONE: Record<OfficeStatus, Tone> = {
  needs_you: "warning",
  working: "primary",
  blocked: "destructive",
  waiting: "muted",
  idle: "muted",
};

/** Labels of the office in the current language: statuses, activities, places and speech bubbles. */
export function useOfficeLabels() {
  const t = useTranslations("office");
  return {
    status: (status: OfficeStatus) => t(`status.${status}`),
    activity: (activity: OfficeActivity) => t(`activity.${activity}`),
    place: (place: "superAgent" | "lounge" | "you") => t(`places.${place}`),
    bubble: (kind: OfficeInteractionKind | "call") => t(`bubble.${kind}`),
  };
}

export type OfficeLabels = ReturnType<typeof useOfficeLabels>;

/** What an agent is on at its desk: the activity while working, then the task, e.g. "Writing · Fix login". */
export function officeSeatDetail(seat: OfficeSeat | null | undefined, labels: OfficeLabels) {
  if (!seat) return null;
  const parts = [seat.activity ? labels.activity(seat.activity) : null, seat.task?.title ?? null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function OfficeStatusChip({ status }: { status: OfficeStatus }) {
  const labels = useOfficeLabels();
  return (
    <ToneBadge tone={STATUS_TONE[status]} pulse={status === "working"}>
      {labels.status(status)}
    </ToneBadge>
  );
}
