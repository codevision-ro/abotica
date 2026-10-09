"use client";

import type { OfficeActivity, OfficeSeat, OfficeState, OfficeStatus, OfficeTaskRef } from "@abotica/core/office";
import { Canvas, useFrame } from "@react-three/fiber";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OfficeSceneProps } from "../office-scene-props";
import { type OfficeLabels, useOfficeLabels } from "../office-status";
import { CameraRig, VIEW_DIR } from "./camera";
import { Character } from "./character";
import { Director, type Home } from "./director";
import { FolderEffects } from "./effects";
import { Lights } from "./lights";
import { Desk } from "./furniture";
import { AgentTag, LabelAnchors, LabelTracker } from "./labels";
import { buildLayout, type Cell, LOUNGE, loungeRoster, type OfficeLayout, type Point, SUPER } from "./layout";
import { type Palette, paletteFor } from "./palette";
import { BaseFloor, CellShell, LoungeDecor, RoomDecor, SuperDecor, WALL_H, WALL_T } from "./rooms";
import { PlaceSign } from "./signs";
import { createScreens, SCROLLING, type ScreenKind } from "./screens";

/**
 * Canvas settings live outside the component: react-three-fiber builds a new camera whenever the `camera`
 * prop is a different object, and a camera rebuilt mid-drag (on any re-render, such as a live refetch)
 * left the view stuck.
 */
const CAMERA = { position: VIEW_DIR.clone().multiplyScalar(60).toArray(), zoom: 30, near: 0.1, far: 400 };
const DPR: [number, number] = [1, 2];

type SeatInfo = { status: OfficeStatus; activity: OfficeActivity | null; task: OfficeTaskRef | null };

/** What decides the floor plan: rooms, their members and how many wait in the lounge. */
const planKey = (s: OfficeState) =>
  [
    s.superAgent?.agentId ?? "",
    loungeRoster(s).join(","),
    ...s.rooms.map((r) => `${r.projectId}:${r.memberIds.join(",")}`),
  ].join("|");

/** Every seat by `${agentId}@${cell}`, the lounge ones idle. */
function seatInfo(state: OfficeState): Map<string, SeatInfo> {
  const info = new Map<string, SeatInfo>();
  const put = (key: string, seat: OfficeSeat | null) =>
    info.set(
      key,
      seat
        ? { status: seat.status, activity: seat.activity, task: seat.task }
        : { status: "idle", activity: null, task: null },
    );
  for (const room of state.rooms) for (const seat of room.seats) put(`${seat.agentId}@${room.projectId}`, seat);
  if (state.superAgent) put(`${state.superAgent.agentId}@${SUPER}`, state.superAgent.seat);
  for (const id of state.loungeIds) put(`${id}@${LOUNGE}`, null);
  return info;
}

/** Where everyone belongs now: seated agents at their desks, the super agent at its own, the rest in the lounge. */
function homesOf(state: OfficeState, layout: OfficeLayout): Home[] {
  const homes: Home[] = [];
  for (const cell of layout.cells) {
    if (cell.kind === "room") {
      const room = state.rooms.find((r) => r.projectId === cell.key);
      for (const seat of room?.seats ?? []) {
        const desk = cell.desks.find((d) => d.agentId === seat.agentId);
        if (desk) homes.push(deskHome(seat.agentId, cell, desk));
      }
    } else if (cell.kind === "super") {
      const desk = cell.desks[0];
      if (desk) homes.push(deskHome(desk.agentId, cell, desk));
    } else {
      for (const agentId of state.loungeIds) {
        const spot = cell.lounge[layout.roster.indexOf(agentId)];
        if (!spot) continue;
        homes.push({
          key: `${agentId}@${LOUNGE}`,
          agentId,
          cell: LOUNGE,
          anchor: spot.seat,
          visitor: spot.visitor,
          pose: spot.kind,
          desk: null,
        });
      }
    }
  }
  return homes;
}

const deskHome = (agentId: string, cell: Cell, desk: Cell["desks"][number]): Home => ({
  key: `${agentId}@${cell.key}`,
  agentId,
  cell: cell.key,
  anchor: desk.seat,
  visitor: desk.visitor,
  pose: "desk",
  desk,
});

const screenOf = (seat: SeatInfo | undefined): ScreenKind =>
  !seat || seat.status === "idle" ? "off" : seat.status === "working" ? (seat.activity ?? "thinking") : seat.status;

/** A short line about what an agent does: the activity or status, and the task. */
function detailOf(seat: SeatInfo, labels: OfficeLabels): string | null {
  if (seat.status === "idle") return null;
  const head = seat.status === "working" && seat.activity ? labels.activity(seat.activity) : labels.status(seat.status);
  return seat.task ? `${head} · ${seat.task.title}` : head;
}

export function OfficeScene({
  state,
  live,
  focusInteractionId,
  onSelectAgent,
  onSelectRoom,
  call,
  party,
}: OfficeSceneProps) {
  const t = useTranslations("office");
  const labels = useOfficeLabels();
  const { resolvedTheme } = useTheme();
  const palette = useMemo(() => paletteFor(resolvedTheme === "dark"), [resolvedTheme]);

  // The floor plan changes only when rooms, members or the lounge do, not on every poll.
  const key = planKey(state);
  const [plan, setPlan] = useState(() => ({ key, layout: buildLayout(state) }));
  if (plan.key !== key) setPlan({ key, layout: buildLayout(state) });
  const layout = plan.layout;

  const seats = useMemo(() => seatInfo(state), [state]);
  const homes = useMemo(() => homesOf(state, layout), [state, layout]);
  const agents = useMemo(() => new Map(state.agents.map((a) => [a.id, a])), [state.agents]);

  const [director] = useState(() => new Director(layout));
  const [, setVersion] = useState(0);
  useEffect(() => {
    director.sync(homes, layout);
  }, [director, layout, homes]);

  const played = useRef(new Set<string>());
  useEffect(() => {
    const now = performance.now();
    for (const interaction of live) {
      if (played.current.has(interaction.id)) continue;
      played.current.add(interaction.id);
      director.play(interaction, now);
    }
  }, [live, director]);

  useEffect(() => {
    if (call) director.callSuper(call.talking, call.text, performance.now());
  }, [call, director]);
  useEffect(() => director.setParty(party), [party, director]);

  const screens = useMemo(() => createScreens(palette), [palette]);
  useEffect(() => () => Object.values(screens).forEach((s) => s.dispose()), [screens]);

  const [zoom, setZoom] = useState(1);

  const focus = useMemo(() => {
    if (!focusInteractionId) return null;
    const interaction = [...live, ...state.interactions].find((i) => i.id === focusInteractionId);
    if (!interaction) return null;
    const at = focusPoint(director, layout, interaction.fromAgentId, interaction.toAgentId, interaction.projectId);
    return at && { key: focusInteractionId, at };
  }, [focusInteractionId, live, state.interactions, director, layout]);

  const [anchors] = useState(() => new LabelAnchors());
  const runtimes = [...director.runtimes.values()];
  const select = (r: (typeof runtimes)[number]) => () =>
    onSelectAgent({ agentId: r.agentId, projectId: r.home.cell === SUPER || r.home.cell === LOUNGE ? null : r.home.cell });

  return (
    // Isolated: the labels' z-indexes order them among themselves, never above the app's dialogs and sheets.
    <div
      className="absolute inset-0 isolate"
      // The middle button drags the view, so the browser's autoscroll must not start.
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
    >
      <Canvas
        orthographic
        flat
        shadows="percentage"
        dpr={DPR}
        camera={CAMERA}
        aria-label={t("scene.label")}
        className="touch-none"
      >
        <Lights palette={palette} layout={layout} director={director} party={party} />
        <CameraRig layout={layout} focus={focus} onZoom={setZoom} />
        <Ticker director={director} screens={screens} onVersion={setVersion} />
        <LabelTracker anchors={anchors} />
        <BaseFloor layout={layout} palette={palette} />
        {layout.cells.map((cell) => (
          <CellView
            key={cell.key}
            cell={cell}
            palette={palette}
            seats={seats}
            screens={screens}
            paused={state.rooms.find((r) => r.projectId === cell.key)?.status === "paused"}
            name={
              cell.kind === "super"
                ? labels.place("superAgent")
                : cell.kind === "lounge"
                  ? labels.place("lounge")
                  : (state.rooms.find((r) => r.projectId === cell.key)?.name ?? "")
            }
            pausedLabel={t("scene.paused")}
            onSelect={cell.kind === "room" ? () => onSelectRoom(cell.key) : undefined}
          />
        ))}
        {runtimes.map((r, i) => {
          const agent = agents.get(r.agentId);
          const seat = seats.get(r.key);
          if (!agent) return null;
          return (
            <Character
              key={r.key}
              runtimeKey={r.key}
              director={director}
              color={agent.avatar.color}
              skin={agent.avatar.background}
              folder={palette.folder}
              status={seat?.status ?? "idle"}
              activity={seat?.activity ?? null}
              seed={i}
              party={party}
              onSelect={select(r)}
            />
          );
        })}
        <FolderEffects director={director} palette={palette} />
      </Canvas>
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {runtimes.map((r) => {
          const agent = agents.get(r.agentId);
          if (!agent) return null;
          const seat = seats.get(r.key) ?? IDLE;
          const said = director.bubbles.get(r.key);
          const urgent = seat.status === "needs_you" || seat.status === "blocked";
          return (
            <AgentTag
              key={r.key}
              anchors={anchors}
              id={`agent:${r.key}`}
              at={() => {
                const now = director.runtimes.get(r.key);
                return now ? { x: now.x, y: 1.32, z: now.z, alpha: now.scale } : null;
              }}
              name={agent.name}
              avatar={agent.avatar}
              status={seat.status}
              statusLabel={labels.status(seat.status)}
              detail={zoom > 1.35 || urgent ? detailOf(seat, labels) : null}
              said={said ? { label: labels.bubble(said.kind), text: said.text, phone: said.phone } : null}
              compact={!said && seat.status === "idle" && zoom < (r.home.cell === LOUNGE ? 2.6 : 1.35)}
              onSelect={select(r)}
            />
          );
        })}
      </div>
    </div>
  );
}

const IDLE: SeatInfo = { status: "idle", activity: null, task: null };

/** Midway between the two people of an interaction, wherever they are now; their room otherwise. */
function focusPoint(
  director: Director,
  layout: OfficeLayout,
  fromId: string | null,
  toId: string | null,
  projectId: string | null,
): Point | null {
  const where = (id: string | null) => {
    if (!id) return null;
    const all = [...director.runtimes.values()].filter((r) => r.agentId === id);
    const r = all.find((x) => x.home.cell === projectId) ?? all[0];
    return r ? { x: r.x, z: r.z } : null;
  };
  const points = [where(fromId), where(toId)].filter((p): p is Point => p !== null);
  if (points.length) {
    return {
      x: points.reduce((s, p) => s + p.x, 0) / points.length,
      z: points.reduce((s, p) => s + p.z, 0) / points.length,
    };
  }
  const cell = layout.cells.find((c) => c.key === projectId);
  return cell ? { x: cell.x + cell.width / 2, z: cell.z + cell.depth / 2 } : null;
}

/** Moves everyone, scrolls the screens, and tells React when the bubbles or the people changed. */
function Ticker({
  director,
  screens,
  onVersion,
}: {
  director: Director;
  screens: Record<ScreenKind, { offset: { y: number } }>;
  onVersion: (v: number) => void;
}) {
  const seen = useRef(-1);
  // Textures are three.js objects moved every frame, so they are reached through a ref.
  const textures = useRef(screens);
  useEffect(() => {
    textures.current = screens;
  }, [screens]);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    director.update(dt, performance.now());
    for (const [kind, speed] of Object.entries(SCROLLING)) textures.current[kind as ScreenKind].offset.y -= dt * speed;
    if (director.version !== seen.current) {
      seen.current = director.version;
      onVersion(director.version);
    }
  });
  return null;
}

function CellView({
  cell,
  palette,
  seats,
  screens,
  paused,
  name,
  pausedLabel,
  onSelect,
}: {
  cell: Cell;
  palette: Palette;
  seats: Map<string, SeatInfo>;
  screens: ReturnType<typeof createScreens>;
  paused: boolean;
  name: string;
  pausedLabel: string;
  /** Rooms open their project from the name board. */
  onSelect?: () => void;
}) {
  return (
    <group>
      <CellShell cell={cell} palette={palette} paused={paused} />
      <PlaceSign
        cell={cell}
        wallHeight={WALL_H}
        wallThickness={WALL_T}
        text={name}
        note={paused ? pausedLabel : null}
        palette={palette}
        onSelect={onSelect}
      />
      {cell.kind === "room" && <RoomDecor cell={cell} palette={palette} />}
      {cell.kind === "super" && <SuperDecor cell={cell} palette={palette} />}
      {cell.kind === "lounge" && <LoungeDecor cell={cell} palette={palette} />}
      {cell.desks.map((desk) => {
        const seat = seats.get(`${desk.agentId}@${cell.key}`);
        const status = seat?.status ?? "idle";
        return (
          <Desk
            key={desk.agentId}
            x={desk.center.x}
            z={desk.center.z}
            palette={palette}
            screen={screens[screenOf(seat)]}
            folder={!!seat?.task}
            lead={desk.lead}
            ring={status === "idle" ? null : palette.status[status]}
            pulse={status === "needs_you"}
          />
        );
      })}
    </group>
  );
}
