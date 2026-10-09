import type { OfficeInteraction, OfficeInteractionKind } from "@abotica/core/office";
import { type Anchor, type Desk, facing, LOUNGE, type OfficeLayout, type Point, route, SUPER } from "./layout";

/**
 * Who stands where and what they are doing, frame by frame, outside React: every interaction becomes a
 * trip (walk to the colleague, say it, walk back), queued per person so nobody does two things at once.
 * The scene renders from it; React state only follows the speech bubbles (see `version`).
 */

export type Pose = "desk" | "sofa" | "stand" | "pouf";

/** Where a person belongs: their desk in a room, the super agent's desk, or a lounge spot. */
export type Home = {
  /** `${agentId}@${cell}`: one person can sit in several rooms at once. */
  key: string;
  agentId: string;
  cell: string;
  anchor: Anchor;
  /** Where a colleague stands to talk to them. */
  visitor: Anchor;
  pose: Pose;
  desk: Desk | null;
};

type Act = "home" | "walk" | "talk";

type Trip =
  | { type: "visit"; interaction: OfficeInteraction; target: Runtime; stage: "out" | "talk" | "back"; until: number }
  | { type: "say"; interaction: OfficeInteraction; until: number }
  | { type: "move" };

type Runtime = {
  key: string;
  agentId: string;
  home: Home;
  x: number;
  z: number;
  yaw: number;
  act: Act;
  path: Point[];
  /**
   * The anchor they stand at, or walk to while walking. Every walk starts from one, so a route always
   * follows aisles and corridors, never a straight line through walls.
   */
  at: Anchor;
  carry: boolean;
  /** Someone they turn their head to while being talked to. */
  lookAt: Point | null;
  lookUntil: number;
  phoneUntil: number;
  trip: Trip | null;
  queue: Trip[];
  /** 0 to 1: grows on arrival, shrinks before leaving. */
  scale: number;
  leaving: boolean;
};

type Bubble = { kind: OfficeInteractionKind; text: string | null; phone: boolean };

/** A folder falling on a desk (work from the user) or sliding into its drawer (put aside) and out. */
type Effect = { id: number; kind: "drop" | "drawer" | "undrawer"; at: Point; start: number; duration: number };

const SPEED = 2.7;
const MAX_TRIPS = 4;
const MAX_QUEUE = 5;
const CARRIES: ReadonlySet<OfficeInteractionKind> = new Set(["delegated", "report", "handoff", "help"]);

/** How long a line stays in the air: long enough to read the excerpt. */
const talkMs = (i: OfficeInteraction) => Math.min(5200, 2600 + (i.text?.length ?? 0) * 25);

export class Director {
  readonly runtimes = new Map<string, Runtime>();
  readonly bubbles = new Map<string, Bubble>();
  effects: Effect[] = [];
  /** Bumped whenever the bubbles or the set of people change, so React renders again. */
  version = 0;
  private nextEffect = 1;

  constructor(private layout: OfficeLayout) {}

  /**
   * Brings everyone to the homes of the new state: newcomers appear, people who changed place walk there.
   * When the floor plan changed (a room came or went), every place moved: everyone is put straight at
   * their home, since walking from where the old plan had them would cross the new walls.
   */
  sync(homes: Home[], layout: OfficeLayout) {
    const replanned = layout !== this.layout;
    this.layout = layout;
    const wanted = new Map(homes.map((h) => [h.key, h]));
    const gone = [...this.runtimes.values()].filter((r) => !wanted.has(r.key));
    if (replanned) {
      for (const runtime of gone) this.runtimes.delete(runtime.key);
      this.bubbles.clear();
      this.effects = [];
    }
    for (const home of homes) {
      const current = this.runtimes.get(home.key);
      if (current) {
        current.leaving = false;
        current.home = home;
        if (replanned) this.settle(current);
        else if (!sameSpot(current.at, home.anchor) && current.act === "home" && !current.trip) this.walkHome(current);
        continue;
      }
      // Someone who left another place comes over on foot (from the lounge to a desk and back).
      const from = replanned ? undefined : gone.find((r) => r.agentId === home.agentId && !r.leaving);
      if (from) {
        gone.splice(gone.indexOf(from), 1);
        this.runtimes.delete(from.key);
        this.hush(from);
        const runtime: Runtime = { ...from, key: home.key, home };
        this.runtimes.set(home.key, runtime);
        if (runtime.trip?.type === "say") runtime.trip = null;
        // Mid-walk, they finish the way they are on and go on from there (see arrive).
        if (runtime.act !== "walk") this.walkHome(runtime);
        continue;
      }
      this.runtimes.set(home.key, {
        key: home.key,
        agentId: home.agentId,
        home,
        x: home.anchor.spot.x,
        z: home.anchor.spot.z,
        yaw: home.anchor.spot.yaw,
        act: "home",
        path: [],
        at: home.anchor,
        carry: false,
        lookAt: null,
        lookUntil: 0,
        phoneUntil: 0,
        trip: null,
        queue: [],
        scale: 0,
        leaving: false,
      });
    }
    if (!replanned) for (const runtime of gone) runtime.leaving = true;
    this.version++;
  }

  /** At home at once, with whatever they were doing dropped (their queue stays). */
  private settle(runtime: Runtime) {
    runtime.x = runtime.home.anchor.spot.x;
    runtime.z = runtime.home.anchor.spot.z;
    runtime.yaw = runtime.home.anchor.spot.yaw;
    runtime.at = runtime.home.anchor;
    runtime.path = [];
    runtime.act = "home";
    runtime.trip = null;
    runtime.carry = false;
    runtime.lookAt = null;
    runtime.phoneUntil = 0;
  }

  /** The person an interaction is about, in its room first, then wherever they are. */
  private find(agentId: string | null, cell: string | null): Runtime | null {
    if (!agentId) return null;
    const exact = cell ? this.runtimes.get(`${agentId}@${cell}`) : undefined;
    if (exact && !exact.leaving) return exact;
    const all = [...this.runtimes.values()].filter((r) => r.agentId === agentId && !r.leaving);
    return all.find((r) => r.home.cell === SUPER) ?? all.find((r) => r.home.cell !== LOUNGE) ?? all[0] ?? null;
  }

  private superAgent(): Runtime | null {
    return [...this.runtimes.values()].find((r) => r.home.cell === SUPER && !r.leaving) ?? null;
  }

  /** Queues an interaction: a visit, a line said in place, or a folder arriving from the user. */
  play(interaction: OfficeInteraction, now: number) {
    const cell = interaction.projectId;
    const from = this.find(interaction.fromAgentId, cell);
    const to = interaction.toAgentId ? this.find(interaction.toAgentId, cell) : this.superAgent();
    if (!from && !to) return;
    if (!from) {
      // From the user (or the platform): the work lands on the desk.
      const target = to!;
      if (interaction.fromAgentId === null && interaction.toAgentId !== null) {
        this.addEffect("drop", target.home.desk?.center ?? target.home.anchor.spot, now, 1100);
      }
      this.enqueue(target, { type: "say", interaction, until: 0 });
      return;
    }
    if (!to || to === from) {
      this.enqueue(from, { type: "say", interaction, until: 0 });
      return;
    }
    this.enqueue(from, { type: "visit", interaction, target: to, stage: "out", until: 0 });
  }

  private enqueue(runtime: Runtime, trip: Trip) {
    runtime.queue.push(trip);
    if (runtime.queue.length > MAX_QUEUE) runtime.queue.splice(0, runtime.queue.length - MAX_QUEUE);
  }

  private addEffect(kind: Effect["kind"], at: Point, now: number, duration: number) {
    this.effects.push({ id: this.nextEffect++, kind, at, start: now, duration });
  }

  /** Walks from the anchor they are at to `to`. */
  private walkTo(runtime: Runtime, to: Anchor) {
    runtime.path = route(this.layout, runtime.at, to);
    runtime.at = to;
    runtime.act = "walk";
  }

  private walkHome(runtime: Runtime) {
    this.walkTo(runtime, runtime.home.anchor);
    runtime.trip = runtime.trip ?? { type: "move" };
  }

  private say(runtime: Runtime, interaction: OfficeInteraction, phone: boolean) {
    this.bubbles.set(runtime.key, { kind: interaction.kind, text: interaction.text, phone });
    this.version++;
  }

  private hush(runtime: Runtime) {
    if (this.bubbles.delete(runtime.key)) this.version++;
  }

  /** Advances everyone by `dt` seconds. */
  update(dt: number, now: number) {
    let busy = [...this.runtimes.values()].filter((r) => r.trip && r.trip.type !== "move").length;
    for (const runtime of this.runtimes.values()) {
      runtime.scale = Math.min(1, Math.max(0, runtime.scale + (runtime.leaving && !runtime.trip ? -dt : dt) * 3));
      if (runtime.leaving && !runtime.trip && runtime.scale === 0) {
        this.runtimes.delete(runtime.key);
        this.hush(runtime);
        this.version++;
        continue;
      }
      if (!runtime.trip && runtime.queue.length && busy < MAX_TRIPS && runtime.scale === 1) {
        this.start(runtime, runtime.queue.shift()!, now);
        busy++;
      }
      if (runtime.act === "walk") this.walk(runtime, dt, now);
      else this.tick(runtime, now);
      if (runtime.act === "home") {
        runtime.yaw = turn(runtime.yaw, runtime.home.anchor.spot.yaw, dt);
      }
    }
    this.effects = this.effects.filter((e) => now - e.start < e.duration + 400);
  }

  private start(runtime: Runtime, trip: Trip, now: number) {
    runtime.trip = trip;
    if (trip.type === "say") {
      trip.until = now + talkMs(trip.interaction);
      const phone = trip.interaction.toAgentId === null && runtime.home.cell === SUPER;
      if (phone) runtime.phoneUntil = trip.until;
      this.say(runtime, trip.interaction, phone);
    } else if (trip.type === "visit") {
      if (trip.target.leaving) {
        runtime.trip = { type: "say", interaction: trip.interaction, until: now + talkMs(trip.interaction) };
        this.say(runtime, trip.interaction, false);
        return;
      }
      this.walkTo(runtime, trip.target.home.visitor);
      runtime.carry = CARRIES.has(trip.interaction.kind);
    }
  }

  private walk(runtime: Runtime, dt: number, now: number) {
    let step = SPEED * dt;
    while (step > 0 && runtime.path.length) {
      const next = runtime.path[0]!;
      const dx = next.x - runtime.x;
      const dz = next.z - runtime.z;
      const d = Math.hypot(dx, dz);
      if (d <= step) {
        runtime.x = next.x;
        runtime.z = next.z;
        runtime.path.shift();
        step -= d;
      } else {
        runtime.x += (dx / d) * step;
        runtime.z += (dz / d) * step;
        runtime.yaw = turn(runtime.yaw, Math.atan2(dx, dz), dt * 1.6);
        step = 0;
      }
    }
    if (runtime.path.length) return;
    this.arrive(runtime, now);
  }

  private arrive(runtime: Runtime, now: number) {
    const trip = runtime.trip;
    if (trip?.type === "visit" && trip.stage === "out") {
      const target = trip.target;
      const i = trip.interaction;
      trip.stage = "talk";
      trip.until = now + talkMs(i);
      runtime.act = "talk";
      runtime.carry = false;
      runtime.yaw = facing(runtime, target);
      target.lookAt = { x: runtime.x, z: runtime.z };
      target.lookUntil = trip.until;
      this.say(runtime, i, false);
      if (i.toAgentId === null && target.home.cell === SUPER) {
        target.phoneUntil = trip.until + 1500;
        this.bubbles.set(target.key, { kind: i.kind, text: null, phone: true });
      }
      const desk = target.home.desk?.center;
      if (desk && i.kind === "put_aside") this.addEffect("drawer", desk, now, 1200);
      if (desk && i.kind === "resumed") this.addEffect("undrawer", desk, now, 1200);
      return;
    }
    // Their home changed on the way (they got work elsewhere): on from here, along the corridors.
    if (!sameSpot(runtime.at, runtime.home.anchor)) {
      this.walkTo(runtime, runtime.home.anchor);
      return;
    }
    runtime.act = "home";
    runtime.trip = null;
  }

  private tick(runtime: Runtime, now: number) {
    const trip = runtime.trip;
    if (runtime.lookAt && now > runtime.lookUntil) runtime.lookAt = null;
    if (runtime.phoneUntil && now > runtime.phoneUntil) {
      runtime.phoneUntil = 0;
      const bubble = this.bubbles.get(runtime.key);
      if (bubble?.phone && !trip) this.hush(runtime);
    }
    if (!trip || now < ("until" in trip ? trip.until : 0)) return;
    if (trip.type === "say") {
      runtime.trip = null;
      this.hush(runtime);
    } else if (trip.type === "visit" && trip.stage === "talk") {
      trip.stage = "back";
      this.hush(runtime);
      this.walkTo(runtime, runtime.home.anchor);
    }
  }
}

const sameSpot = (a: Anchor, b: Anchor) =>
  a.cell === b.cell && Math.abs(a.spot.x - b.spot.x) < 1e-6 && Math.abs(a.spot.z - b.spot.z) < 1e-6;

/** Turns `from` towards `to` by the shortest way, at about two turns a second. */
function turn(from: number, to: number, dt: number) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * Math.min(1, dt * 10);
}
