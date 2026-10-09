import type { OfficeState } from "@abotica/core/office";

/**
 * Where everything stands on the office floor, in world units on the ground plane (x to the right,
 * z towards the viewer). Every place is a cell of a grid: the super agent's office, the lounge, then one
 * room per project. Rooms have walls at the back (-z) and on the left (-x) only, so people walk out to
 * the right; corridors run between the cells, so a route never crosses a desk.
 */

export type Point = { x: number; z: number };
/** A point plus the way a person standing there faces (yaw: 0 looks towards +z). */
export type Spot = Point & { yaw: number };

/** A place a person can be: where they stand or sit, and the aisle point they come and go through. */
export type Anchor = { cell: string; spot: Spot; aisle: Point };

export type Desk = {
  agentId: string;
  /** Center of the desk top; the person sits at +z of it, facing -z. */
  center: Point;
  seat: Anchor;
  /** Where a visitor stands, beside the chair, facing the person. */
  visitor: Anchor;
  lead: boolean;
};

export type LoungeSpot = { seat: Anchor; visitor: Anchor; kind: "sofa" | "stand" | "pouf" };

export type CellKind = "super" | "lounge" | "room";

export type Cell = {
  /** "super", "lounge", or the project id. */
  key: string;
  kind: CellKind;
  x: number;
  z: number;
  width: number;
  depth: number;
  desks: Desk[];
  lounge: LoungeSpot[];
  /** The corridor on the right of the cell's column, and the one in front of its row. */
  laneX: number;
  frontZ: number;
  /** A walkway inside the cell along its open right side, between the desk rows. */
  innerX: number;
};

export type OfficeLayout = {
  cells: Cell[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
};

export const SUPER = "super";
export const LOUNGE = "lounge";
/** Centers of the two lounge sofas, from the lounge's back-left corner. */
export const LOUNGE_SOFAS = [2.1, 4.3];

const GAP = 1.8;
const PAD = 0.7;
const SLOT_W = 2.3;
const SLOT_D = 2.3;
const INNER = 0.9;
const SEAT_DZ = 0.55;
const AISLE_DZ = 1.1;

const yawTo = (from: Point, to: Point) => Math.atan2(to.x - from.x, to.z - from.z);

function desk(cell: string, agentId: string, cx: number, cz: number, lead: boolean): Desk {
  const seat = { x: cx, z: cz + SEAT_DZ };
  const aisle = { x: cx, z: cz + AISLE_DZ };
  const visitor = { x: cx + 0.72, z: cz + SEAT_DZ + 0.25 };
  return {
    agentId,
    center: { x: cx, z: cz },
    seat: { cell, spot: { ...seat, yaw: Math.PI }, aisle },
    visitor: { cell, spot: { ...visitor, yaw: yawTo(visitor, seat) }, aisle },
    lead,
  };
}

/** A room: the manager's desk alone in the back row, the team in rows of up to three in front. */
function roomCell(key: string, memberIds: string[], managerId: string | null): Omit<Cell, "x" | "z" | "laneX" | "frontZ"> {
  const lead = managerId && memberIds.includes(managerId) ? managerId : null;
  const team = memberIds.filter((id) => id !== lead);
  const cols = Math.min(3, Math.max(2, team.length));
  const rows = (lead ? 1 : 0) + Math.max(1, Math.ceil(team.length / cols));
  const width = PAD + cols * SLOT_W + INNER;
  const depth = PAD * 0.6 + rows * SLOT_D + 0.2;
  const desks: Desk[] = [];
  let row = 0;
  const rowZ = (r: number) => PAD * 0.6 + SLOT_D * r + 0.75;
  if (lead) {
    desks.push(desk(key, lead, PAD + (cols * SLOT_W) / 2, rowZ(0), true));
    row = 1;
  }
  team.forEach((id, i) => {
    desks.push(desk(key, id, PAD + SLOT_W * ((i % cols) + 0.5), rowZ(row + Math.floor(i / cols)), false));
  });
  return { key, kind: "room", width, depth, desks, lounge: [], innerX: width - INNER / 2 };
}

function superCell(agentId: string | null): Omit<Cell, "x" | "z" | "laneX" | "frontZ"> {
  const width = PAD + SLOT_W * 1.4 + INNER;
  const depth = PAD * 0.6 + SLOT_D + 0.9;
  const desks = agentId ? [desk(SUPER, agentId, PAD + SLOT_W * 0.7, PAD * 0.6 + 1.15, true)] : [];
  return { key: SUPER, kind: "super", width, depth, desks, lounge: [], innerX: width - INNER / 2 };
}

/**
 * The lounge: two sofas at the back facing the coffee table, two places at the coffee counter on the
 * left, then poufs in rows in front for as many as needed.
 */
function loungeCell(count: number): Omit<Cell, "x" | "z" | "laneX" | "frontZ"> {
  const spots: LoungeSpot[] = [];
  const width = 6.6;
  const place = (kind: LoungeSpot["kind"], x: number, z: number, yaw: number, aisleZ: number) => {
    const seat = { x, z };
    const visitor = { x: x + Math.sin(yaw) * 0.75, z: z + Math.cos(yaw) * 0.75 };
    spots.push({
      kind,
      seat: { cell: LOUNGE, spot: { ...seat, yaw }, aisle: { x, z: aisleZ } },
      visitor: { cell: LOUNGE, spot: { ...visitor, yaw: yawTo(visitor, seat) }, aisle: { x, z: aisleZ } },
    });
  };
  // Sofa seats face the room over an open rug; their walkway runs in front of it.
  for (const sofaX of LOUNGE_SOFAS) for (const dx of [-0.55, 0, 0.55]) place("sofa", sofaX + dx, 1.05, 0, 3.0);
  place("stand", 1.05, 3.0, -Math.PI / 2, 3.0);
  place("stand", 1.05, 3.7, -Math.PI / 2, 3.7);
  const extra = Math.max(0, count - spots.length);
  const rows = Math.ceil(extra / 4);
  for (let i = 0; i < extra; i++) {
    const r = Math.floor(i / 4);
    place("pouf", 2.3 + (i % 4) * 1.05, 4.5 + r * 1.3, Math.PI, 5.1 + r * 1.3);
  }
  const depth = 5.4 + rows * 1.3;
  return { key: LOUNGE, kind: "lounge", width, depth, desks: [], lounge: spots, innerX: width - INNER / 2 };
}

export function buildLayout(state: OfficeState): OfficeLayout {
  const cells = [
    superCell(state.superAgent?.agentId ?? null),
    loungeCell(state.loungeIds.length),
    ...state.rooms.map((r) => roomCell(r.projectId, r.memberIds, r.managerAgentId)),
  ];
  const n = cells.length;
  const columns = n <= 3 ? n : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const rows = Math.ceil(n / columns);
  const colWidth = Array.from({ length: columns }, (_, c) =>
    Math.max(...cells.filter((_, i) => i % columns === c).map((cell) => cell.width)),
  );
  const rowDepth = Array.from({ length: rows }, (_, r) =>
    Math.max(...cells.slice(r * columns, r * columns + columns).map((cell) => cell.depth)),
  );
  const colX = colWidth.map((_, c) => colWidth.slice(0, c).reduce((s, w) => s + w + GAP, 0));
  const rowZ = rowDepth.map((_, r) => rowDepth.slice(0, r).reduce((s, d) => s + d + GAP, 0));
  const totalW = colX[columns - 1]! + colWidth[columns - 1]!;
  const totalD = rowZ[rows - 1]! + rowDepth[rows - 1]!;
  const ox = -totalW / 2;
  const oz = -totalD / 2;

  const placed: Cell[] = cells.map((cell, i) => {
    const c = i % columns;
    const r = Math.floor(i / columns);
    const x = ox + colX[c]!;
    const z = oz + rowZ[r]!;
    const move = (a: Anchor): Anchor => ({
      cell: a.cell,
      spot: { x: a.spot.x + x, z: a.spot.z + z, yaw: a.spot.yaw },
      aisle: { x: a.aisle.x + x, z: a.aisle.z + z },
    });
    return {
      ...cell,
      x,
      z,
      innerX: cell.innerX + x,
      laneX: x + colWidth[c]! + GAP / 2,
      frontZ: z + rowDepth[r]! + GAP / 2,
      desks: cell.desks.map((d) => ({
        ...d,
        center: { x: d.center.x + x, z: d.center.z + z },
        seat: move(d.seat),
        visitor: move(d.visitor),
      })),
      lounge: cell.lounge.map((s) => ({ ...s, seat: move(s.seat), visitor: move(s.visitor) })),
    };
  });
  return { cells: placed, bounds: { minX: ox, maxX: ox + totalW, minZ: oz, maxZ: oz + totalD } };
}

/**
 * The way from one anchor to another along aisles and corridors: out to the walkway or corridor on the
 * right, along the corridor in front of the row, then in the same way at the other end.
 */
export function route(layout: OfficeLayout, from: Anchor, to: Anchor): Point[] {
  const a = layout.cells.find((c) => c.key === from.cell);
  const b = layout.cells.find((c) => c.key === to.cell);
  const points: Point[] = [from.spot, from.aisle];
  if (!a || !b) points.push(to.aisle);
  else if (a === b) {
    if (Math.abs(from.aisle.z - to.aisle.z) > 0.01) {
      points.push({ x: a.innerX, z: from.aisle.z }, { x: a.innerX, z: to.aisle.z });
    }
    points.push(to.aisle);
  } else {
    points.push(
      { x: a.laneX, z: from.aisle.z },
      { x: a.laneX, z: a.frontZ },
      { x: b.laneX, z: a.frontZ },
      { x: b.laneX, z: to.aisle.z },
      to.aisle,
    );
  }
  points.push(to.spot);
  return points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1]!.x, p.z - points[i - 1]!.z) > 0.01);
}

export const facing = yawTo;
