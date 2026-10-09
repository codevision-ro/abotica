"use client";

import type { OfficeInteraction, OfficeState } from "@abotica/core/office";
import { ActivityIcon, ChevronDownIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLiveEvent } from "@/components/app/live-updates";
import { useTaskParams } from "@/components/tasks/task-meta";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { OfficeFeed } from "./office-feed";
import { OfficeList } from "./office-list";
import type { OfficeAgentTarget, OfficeSceneProps } from "./office-scene-props";

const OfficeScene = dynamic<OfficeSceneProps>(() => import("./scene/office-scene").then((m) => m.OfficeScene), {
  ssr: false,
  loading: () => <Skeleton className="absolute inset-0 rounded-none" />,
});

const POLL_MS = 4000;
const LIVE_DEBOUNCE_MS = 300;
const LIVE_CAP = 100;

/** 3D only on a desktop-sized screen for users who do not ask for reduced motion. */
const SCENE_QUERY = "(min-width: 768px) and (prefers-reduced-motion: no-preference)";
const subscribeMode = (onChange: () => void) => {
  const mql = window.matchMedia(SCENE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
};
const modeSnapshot = () => (window.matchMedia(SCENE_QUERY).matches ? "3d" : "2d");
const serverMode = () => null;

type Data = { state: OfficeState; live: OfficeInteraction[] };

/**
 * Takes a newer read: older ones (a slow poll overtaken by a live refetch) are dropped. Interactions not in
 * the first state are appended to `live` oldest first, so the scene plays each one once.
 */
function merge(prev: Data, next: OfficeState, firstIds: Set<string>): Data {
  if (Date.parse(next.generatedAt) <= Date.parse(prev.state.generatedAt)) return prev;
  const known = new Set(prev.live.map((i) => i.id));
  const arrived = next.interactions.filter((i) => !firstIds.has(i.id) && !known.has(i.id)).reverse();
  const live = arrived.length ? [...prev.live, ...arrived].slice(-LIVE_CAP) : prev.live;
  return { state: next, live };
}

export function OfficeView({ initial }: { initial: OfficeState }) {
  const router = useRouter();
  const { openOverlay } = useTaskParams();
  const mode = useSyncExternalStore(subscribeMode, modeSnapshot, serverMode);

  const [firstIds] = useState(() => new Set(initial.interactions.map((i) => i.id)));
  const [data, setData] = useState<Data>({ state: initial, live: [] });
  // The server page re-reads the office on navigation and live refreshes: take it when it is newer.
  const [seenInitial, setSeenInitial] = useState(initial);
  if (initial !== seenInitial) {
    setSeenInitial(initial);
    setData((prev) => merge(prev, initial, firstIds));
  }

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/office", { cache: "no-store" });
      if (!res.ok) return;
      const next = (await res.json()) as OfficeState;
      setData((prev) => merge(prev, next, firstIds));
    } catch {
      // Offline or the server restarting: the next poll tries again.
    }
  }, [firstIds]);

  const liveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useLiveEvent(() => {
    clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => void refetch(), LIVE_DEBOUNCE_MS);
  });
  useEffect(() => () => clearTimeout(liveTimer.current), []);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void refetch();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refetch]);

  const { state, live } = data;

  const onSelectAgent = useCallback(
    ({ agentId, projectId }: OfficeAgentTarget) => {
      const seat = projectId
        ? state.rooms.find((r) => r.projectId === projectId)?.seats.find((s) => s.agentId === agentId)
        : state.superAgent?.agentId === agentId
          ? state.superAgent.seat
          : null;
      if (seat?.task) openOverlay({ task: seat.task.id });
      else router.push(`/agents/${agentId}`);
    },
    [state, openOverlay, router],
  );
  const onSelectRoom = useCallback((projectId: string) => router.push(`/projects/${projectId}`), [router]);

  const [focusInteractionId, setFocusInteractionId] = useState<string | null>(null);

  if (mode === null) return <Skeleton className="min-h-0 flex-1 rounded-2xl" />;

  if (mode === "2d") {
    return (
      <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4 md:-mx-6 md:px-6">
        <OfficeList
          state={state}
          onSelectAgent={onSelectAgent}
          onSelectRoom={onSelectRoom}
          onSelectInteraction={(i) => openOverlay({ task: i.task.id })}
        />
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-border/70 bg-muted/30 dark:bg-muted/15">
      <OfficeScene
        state={state}
        live={live}
        focusInteractionId={focusInteractionId}
        onSelectAgent={onSelectAgent}
        onSelectRoom={onSelectRoom}
      />
      <FeedPanel state={state} selectedId={focusInteractionId} onSelect={(i) => setFocusInteractionId(i.id)} />
    </div>
  );
}

/** The feed floating over the scene, top right; collapses to its header. */
function FeedPanel({
  state,
  selectedId,
  onSelect,
}: {
  state: OfficeState;
  selectedId: string | null;
  onSelect: (interaction: OfficeInteraction) => void;
}) {
  const t = useTranslations("office.feed");
  const [open, setOpen] = useState(true);
  return (
    <section
      aria-label={t("title")}
      className="absolute top-3 right-3 flex max-h-[calc(100%-1.5rem)] w-80 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border border-border/70 bg-card/85 shadow-sm backdrop-blur-md dark:bg-card/75"
    >
      <button
        type="button"
        aria-expanded={open}
        title={open ? t("hide") : t("show")}
        onClick={() => setOpen((o) => !o)}
        className="flex shrink-0 items-center gap-2 px-3 py-2 text-left text-sm font-medium outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <ActivityIcon className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="flex-1">
          {t("title")}
          {state.interactions.length > 0 && (
            <span className="tabular ml-1.5 text-xs font-normal text-muted-foreground">{state.interactions.length}</span>
          )}
        </span>
        <ChevronDownIcon
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")}
          aria-hidden
        />
      </button>
      {open && (
        <div className="min-h-0 overflow-y-auto border-t border-border/60">
          <OfficeFeed state={state} selectedId={selectedId} onSelect={onSelect} className="[&_li>*]:px-3" />
        </div>
      )}
    </section>
  );
}
