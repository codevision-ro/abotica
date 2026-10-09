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

/** `dance`: on the lounge floor during a party, between two moves. */
type Act = "home" | "walk" | "talk" | "dance";

type Trip =
  | {
      type: "visit";
      interaction: OfficeInteraction;
      target: Runtime;
      stage: "out" | "talk" | "back";
      until: number;
      /** When it was queued: a visit waits for its colleague to be at their desk, but not forever. */
      queuedAt: number;
    }
  | { type: "say"; interaction: OfficeInteraction; until: number }
  | { type: "move" }
  /** Party: to a spot on the lounge floor and dancing there until `until`, then on to another one. */
  | { type: "dance"; until: number };

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
  /** Colleagues on their way to talk to them or talking to them now: they stay put until it is over. */
  visitors: number;
  /** A move (to a new home, or out) held back while they are being visited. */
  pendingMove: boolean;
};

/** A line in the air; "call" is the super agent on the phone with the user. */
type Bubble = { kind: OfficeInteractionKind | "call"; text: string | null; phone: boolean };

/** A folder falling on a desk (work from the user) or sliding into its drawer (put aside) and out. */
type Effect = { id: number; kind: "drop" | "drawer" | "undrawer"; at: Point; start: number; duration: number };

const SPEED = 2.7;
const MAX_TRIPS = 4;
const MAX_QUEUE = 5;
/** How long a visit waits for a colleague who is away from their desk before it is said from afar. */
const VISIT_WAIT_MS = 60_000;
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
  /** Until the first sync everyone is simply at home; after it, newcomers walk in. */
  private started = false;
  /** Party mode: the lounge dances on its floor. */
  private party = false;

  setParty(on: boolean) {
    this.party = on;
  }

  constructor(private layout: OfficeLayout) {}

  /**
   * Brings everyone to the homes of the new state. People who changed place walk there; someone new to the
   * office (or a second desk of someone busy elsewhere) comes in by the lounge door, and someone with no
   * place left walks out by it.
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
      for (const runtime of this.runtimes.values()) {
        runtime.visitors = 0;
        runtime.pendingMove = false;
      }
      this.bubbles.clear();
      this.effects = [];
    }
    for (const home of homes) {
      const current = this.runtimes.get(home.key);
      if (current) {
        current.leaving = false;
        current.home = home;
        if (replanned) this.settle(current);
        else if (!sameSpot(current.at, home.anchor)) this.relocate(current);
        continue;
      }
      // Someone who left another place comes over on foot (from the lounge to a desk and back).
      const from = replanned ? undefined : gone.find((r) => r.agentId === home.agentId);
      if (from) {
        gone.splice(gone.indexOf(from), 1);
        this.runtimes.delete(from.key);
        this.hush(from);
        // The same object moves to its new key: colleagues on their way to it still find it.
        from.key = home.key;
        from.home = home;
        from.leaving = false;
        this.runtimes.set(home.key, from);
        if (from.trip?.type === "say") from.trip = null;
        this.relocate(from);
        continue;
      }
      const walksIn = this.started && !replanned;
      const start = walksIn ? this.layout.door : home.anchor;
      const runtime: Runtime = {
        key: home.key,
        agentId: home.agentId,
        home,
        x: start.spot.x,
        z: start.spot.z,
        yaw: start.spot.yaw,
        act: "home",
        path: [],
        at: start,
        carry: false,
        lookAt: null,
        lookUntil: 0,
        phoneUntil: 0,
        trip: null,
        queue: [],
        scale: 0,
        leaving: false,
        visitors: 0,
        pendingMove: false,
      };
      this.runtimes.set(home.key, runtime);
      if (walksIn) this.walkHome(runtime);
    }
    if (!replanned) {
      for (const runtime of gone) {
        if (runtime.leaving) continue;
        runtime.leaving = true;
        this.hush(runtime);
        if (runtime.trip?.type === "say") runtime.trip = null;
        this.relocate(runtime);
      }
    }
    this.started = true;
    this.version++;
  }

  /**
   * Sends someone to their (new) destination: at once when free; after the visit when a colleague is on
   * the way or talking to them; mid-walk, they finish the way they are on and go on from there (arrive).
   */
  private relocate(runtime: Runtime) {
    if (runtime.visitors > 0) runtime.pendingMove = true;
    else if (runtime.act === "home" && !runtime.trip) this.walkHome(runtime);
  }

  /** The open floor of the lounge, between the sofas and the poufs, where the party dances. */
  private danceFloor() {
    const lounge = this.layout.cells.find((c) => c.key === LOUNGE);
    if (!lounge) return null;
    return { x: lounge.x + 3.5, z: lounge.z + 2.65, halfX: 1.9, halfZ: 0.95 };
  }

  /**
   * Party: someone resting in the lounge, with nothing else on, goes to a random spot on the floor and
   * dances there a few seconds, then moves to another. Work, a colleague coming over, a new place or the
   * end of the party sends them back to their spot (or wherever their home is now).
   */
  private dance(runtime: Runtime, now: number, awaited: boolean) {
    const floor = this.danceFloor();
    const trip = runtime.trip;
    const stop =
      !this.party ||
      !floor ||
      runtime.home.cell !== LOUNGE ||
      runtime.leaving ||
      runtime.pendingMove ||
      runtime.queue.length > 0 ||
      runtime.visitors > 0 ||
      awaited;
    if (trip?.type === "dance") {
      if (runtime.act !== "dance") return;
      if (stop) {
        runtime.trip = { type: "move" };
        this.walkTo(runtime, this.destination(runtime));
      } else if (now > trip.until) this.danceTo(runtime, floor);
      return;
    }
    if (stop || trip || runtime.act !== "home" || runtime.scale < 1) return;
    runtime.trip = { type: "dance", until: 0 };
    this.danceTo(runtime, floor);
  }

  private danceTo(runtime: Runtime, floor: NonNullable<ReturnType<Director["danceFloor"]>>) {
    const at = {
      x: floor.x + (Math.random() * 2 - 1) * floor.halfX,
      z: floor.z + (Math.random() * 2 - 1) * floor.halfZ,
    };
    this.walkTo(runtime, { cell: LOUNGE, spot: { ...at, yaw: runtime.yaw }, aisle: at });
  }

  /** Whether a colleague can come over now: at their desk, doing nothing else, with nobody else there. */
  private receives(target: Runtime) {
    return (
      this.runtimes.get(target.key) === target &&
      !target.leaving &&
      !target.pendingMove &&
      target.act === "home" &&
      !target.trip &&
      target.visitors === 0
    );
  }

  /** Where someone goes when nothing else is on: home, or the door once they have no place left. */
  private destination(runtime: Runtime): Anchor {
    return runtime.leaving ? this.layout.door : runtime.home.anchor;
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

  /**
   * The user on the intercom: the super agent holds the phone while it answers, saying the start of its
   * answer, and hangs up a few seconds after it is done.
   */
  callSuper(talking: boolean, text: string | null, now: number) {
    const boss = this.superAgent();
    if (!boss) return;
    if (talking) {
      boss.phoneUntil = now + 3_600_000;
      this.bubbles.set(boss.key, { kind: "call", text, phone: true });
    } else if (boss.phoneUntil > now) {
      boss.phoneUntil = now + (text ? 5000 : 0);
      if (text) this.bubbles.set(boss.key, { kind: "call", text, phone: true });
    } else return;
    this.version++;
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
    this.enqueue(from, { type: "visit", interaction, target: to, stage: "out", until: 0, queuedAt: now });
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
    this.walkTo(runtime, this.destination(runtime));
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
    let busy = [...this.runtimes.values()].filter(
      (r) => r.trip && r.trip.type !== "move" && r.trip.type !== "dance",
    ).length;
    // People a colleague is waiting to visit: a dancer among them goes back to their spot first.
    const awaited = new Set<Runtime>();
    for (const r of this.runtimes.values()) if (r.queue[0]?.type === "visit") awaited.add(r.queue[0].target);
    for (const runtime of this.runtimes.values()) {
      const gone = runtime.leaving && !runtime.trip && !runtime.pendingMove && runtime.visitors === 0;
      runtime.scale = Math.min(1, Math.max(0, runtime.scale + (gone ? -dt : dt) * 3));
      if (gone && runtime.scale === 0) {
        this.runtimes.delete(runtime.key);
        this.hush(runtime);
        this.version++;
        continue;
      }
      if (runtime.pendingMove && runtime.visitors === 0 && runtime.act === "home" && !runtime.trip) {
        runtime.pendingMove = false;
        this.walkHome(runtime);
      }
      this.dance(runtime, now, awaited.has(runtime));
      const next = runtime.queue[0];
      const free = !runtime.trip && !runtime.pendingMove && runtime.visitors === 0 && runtime.scale === 1;
      if (next && free && busy < MAX_TRIPS) {
        // A visit waits until the colleague is at their desk to receive it; past a while it is said from here.
        const waits = next.type === "visit" && !this.receives(next.target);
        const overdue = next.type === "visit" && now - next.queuedAt > VISIT_WAIT_MS;
        if (waits && overdue) runtime.queue[0] = { type: "say", interaction: next.interaction, until: 0 };
        if (!waits || overdue) {
          this.start(runtime, runtime.queue.shift()!, now);
          busy++;
        }
      }
      if (runtime.act === "walk") this.walk(runtime, dt, now);
      else this.tick(runtime, now);
      if (runtime.act === "home") {
        runtime.yaw = turn(runtime.yaw, runtime.home.anchor.spot.yaw, dt);
      } else if (runtime.act === "dance") {
        // Facing the middle of the floor, swaying.
        const middle = this.danceFloor();
        const face = middle ? Math.atan2(middle.x - runtime.x, middle.z - runtime.z) : runtime.yaw;
        runtime.yaw = turn(runtime.yaw, face + Math.sin(now / 600 + runtime.x) * 0.6, dt * 0.4);
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
      trip.target.visitors++;
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
    if (trip?.type === "dance") {
      runtime.act = "dance";
      trip.until = now + 2500 + Math.random() * 4500;
      return;
    }
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
    // Their home changed on the way (they got work elsewhere, or none is left): on from here, along the
    // corridors.
    const destination = this.destination(runtime);
    if (!sameSpot(runtime.at, destination)) {
      this.walkTo(runtime, destination);
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
      trip.target.visitors = Math.max(0, trip.target.visitors - 1);
      this.hush(runtime);
      this.walkTo(runtime, this.destination(runtime));
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
