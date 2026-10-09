"use client";

import type { OfficeStatus } from "@abotica/core/office";
import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { useFrame } from "@react-three/fiber";
import { PhoneIcon } from "lucide-react";
import { useCallback } from "react";
import { Vector3 } from "three";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { cn } from "@/lib/utils";

/**
 * Labels are plain DOM over the canvas, rendered by the page's React tree; every frame the tracker moves
 * each one to where its point in the office lands on screen, so they follow people as they walk.
 */

type Placement = { x: number; y: number; z: number; alpha: number };

type Anchor = {
  el: HTMLElement;
  at: () => Placement | null;
  /** People's labels move up out of each other's way; place names stay put. */
  stack: boolean;
  /** The current upward nudge in pixels, eased so labels do not jump. */
  lift: number;
};

export class LabelAnchors {
  readonly items = new Map<string, Anchor>();
}

const point = new Vector3();
const GAP = 3;

/**
 * Inside the canvas: places every registered label on screen, nearer ones on top. Where people's labels
 * would overlap (two colleagues talking at one desk), the farther one moves up above the nearer one.
 */
export function LabelTracker({ anchors }: { anchors: LabelAnchors }) {
  useFrame(({ camera, size }, delta) => {
    const shown: { a: Anchor; x: number; y: number; depth: number; w: number; h: number }[] = [];
    for (const a of anchors.items.values()) {
      const p = a.at();
      if (!p || p.alpha <= 0.05) {
        a.el.style.visibility = "hidden";
        continue;
      }
      point.set(p.x, p.y, p.z).project(camera);
      const inner = a.el.firstElementChild as HTMLElement | null;
      shown.push({
        a,
        x: ((point.x + 1) / 2) * size.width,
        y: ((1 - point.y) / 2) * size.height,
        depth: point.z,
        w: inner?.offsetWidth ?? 0,
        h: inner?.offsetHeight ?? 0,
      });
      a.el.style.visibility = "visible";
      a.el.style.opacity = String(p.alpha);
      a.el.style.zIndex = String(Math.round((1 - point.z) * 5000));
    }
    // Place names stay where they are and people's labels keep clear of them; among people, the nearest
    // keeps its place and the ones behind it make room.
    shown.sort((l, r) => Number(l.a.stack) - Number(r.a.stack) || l.depth - r.depth);
    const placed: { left: number; right: number; top: number; bottom: number }[] = [];
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 14);
    for (const s of shown) {
      let bottom = s.y;
      if (s.a.stack) {
        const left = s.x - s.w / 2;
        const right = s.x + s.w / 2;
        for (let tries = 0; tries < 6; tries++) {
          const hit = placed.find(
            (r) => left < r.right + GAP && right > r.left - GAP && bottom - s.h < r.bottom + GAP && bottom > r.top - GAP,
          );
          if (!hit) break;
          bottom = hit.top - GAP;
        }
        placed.push({ left, right, top: bottom - s.h, bottom });
        s.a.lift += (s.y - bottom - s.a.lift) * k;
      } else {
        placed.push({ left: s.x, right: s.x + s.w, top: s.y - s.h, bottom: s.y });
      }
      s.a.el.style.transform = `translate3d(${s.x.toFixed(1)}px, ${(s.y - s.a.lift).toFixed(1)}px, 0)`;
    }
  });
  return null;
}

/** A ref callback that registers an element under `id` while it is mounted. */
function useAnchor(anchors: LabelAnchors, id: string, at: () => Placement | null, stack: boolean) {
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      anchors.items.set(id, { el, at, stack, lift: anchors.items.get(id)?.lift ?? 0 });
      return () => void anchors.items.delete(id);
    },
    [anchors, id, at, stack],
  );
}

const DOT: Record<OfficeStatus, string> = {
  working: "bg-primary",
  needs_you: "bg-warning",
  blocked: "bg-destructive",
  waiting: "bg-muted-foreground/60",
  idle: "bg-muted-foreground/30",
};

const DETAIL: Partial<Record<OfficeStatus, string>> = {
  needs_you: "border-warning/50 text-warning",
  blocked: "border-destructive/40 text-destructive",
};

type SaidLine = { label: string; text: string | null; phone: boolean };

const anchorClass = "pointer-events-none invisible absolute top-0 left-0 will-change-transform";

/**
 * An agent's name with its status dot, and above it what it says now or, when `detail` is set, what it
 * does. `compact` keeps only the avatar (people resting in the lounge, seen from afar).
 */
export function AgentTag({
  anchors,
  id,
  at,
  name,
  avatar,
  status,
  statusLabel,
  detail,
  said,
  compact,
  onSelect,
}: {
  anchors: LabelAnchors;
  id: string;
  at: () => Placement | null;
  name: string;
  avatar: AgentAvatarValue;
  status: OfficeStatus;
  statusLabel: string;
  detail: string | null;
  said: SaidLine | null;
  compact: boolean;
  onSelect: () => void;
}) {
  const ref = useAnchor(anchors, id, at, true);
  return (
    <div ref={ref} className={anchorClass}>
      <div className="flex w-max max-w-60 -translate-x-1/2 -translate-y-full flex-col items-center gap-1 select-none">
        {said ? (
          <div className="animate-in fade-in-0 zoom-in-95 max-w-60 rounded-xl border border-primary/30 bg-card px-2.5 py-1.5 text-xs shadow-md duration-200">
            <p className="flex items-center gap-1 font-medium text-primary">
              {said.phone && <PhoneIcon className="size-3" aria-hidden />}
              {said.label}
            </p>
            {said.text && <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{said.text}</p>}
          </div>
        ) : (
          detail && (
            <div
              className={cn(
                "max-w-52 truncate rounded-lg border border-border/80 bg-card/95 px-2 py-0.5 text-[11px] text-muted-foreground shadow-sm",
                DETAIL[status],
              )}
            >
              {detail}
            </div>
          )
        )}
        <button
          type="button"
          onClick={onSelect}
          title={compact ? `${name}: ${statusLabel}` : statusLabel}
          aria-label={`${name}: ${statusLabel}`}
          className={cn(
            "pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/80 bg-background/90 p-0.5 text-[11px] font-medium shadow-sm backdrop-blur-sm outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50",
            !compact && "pr-2",
          )}
        >
          <AgentAvatar avatar={avatar} size="xs" className="rounded-full" />
          {!compact && (
            <>
              <span className="max-w-32 truncate">{name}</span>
              <span
                className={cn("size-1.5 shrink-0 rounded-full", DOT[status], status === "needs_you" && "animate-pulse")}
              />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/** A place's name over its back-left wall corner; rooms open their project. */
export function PlaceTag({
  anchors,
  id,
  at,
  name,
  note,
  onSelect,
}: {
  anchors: LabelAnchors;
  id: string;
  at: () => Placement | null;
  name: string;
  note?: string | null;
  onSelect?: () => void;
}) {
  const ref = useAnchor(anchors, id, at, false);
  const className =
    "flex items-center gap-1.5 rounded-md border border-border/80 bg-card/95 px-2 py-1 text-xs font-semibold whitespace-nowrap shadow-sm backdrop-blur-sm";
  return (
    <div ref={ref} className={anchorClass}>
      <div className="-translate-y-full pb-1 select-none">
        {onSelect ? (
          <button
            type="button"
            onClick={onSelect}
            className={cn(
              className,
              "pointer-events-auto outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50",
            )}
          >
            {name}
            {note && <span className="font-normal text-muted-foreground">{note}</span>}
          </button>
        ) : (
          <div className={className}>{name}</div>
        )}
      </div>
    </div>
  );
}
