import type { OfficeState } from "@abotica/core/office";
import { describe, expect, it } from "vitest";
import { buildLayout, type Cell, LOUNGE, type Point, route, SUPER } from "./layout";

function state(rooms: { id: string; members: string[]; manager?: string }[], lounge = 2): OfficeState {
  return {
    agents: [],
    superAgent: { agentId: "boss", seat: null },
    rooms: rooms.map((r) => ({
      projectId: r.id,
      name: r.id,
      status: "active",
      managerAgentId: r.manager ?? null,
      memberIds: r.members,
      seats: [],
    })),
    loungeIds: Array.from({ length: lounge }, (_, i) => `idle-${i}`),
    interactions: [],
    generatedAt: new Date(0).toISOString(),
  };
}

const inside = (cell: Cell, p: Point) =>
  p.x > cell.x && p.x < cell.x + cell.width && p.z > cell.z && p.z < cell.z + cell.depth;

const overlaps = (a: Cell, b: Cell) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.z < b.z + b.depth && b.z < a.z + a.depth;

describe("buildLayout", () => {
  const layout = buildLayout(
    state([
      { id: "shop", members: ["m1", "a", "b", "c", "d"], manager: "m1" },
      { id: "blog", members: ["m2", "a"], manager: "m2" },
      { id: "app", members: [] },
    ]),
  );

  it("gives the super agent, the lounge and every project a cell, none overlapping", () => {
    expect(layout.cells.map((c) => c.key)).toEqual([SUPER, LOUNGE, "shop", "blog", "app"]);
    for (const [i, a] of layout.cells.entries()) {
      for (const b of layout.cells.slice(i + 1)) expect(overlaps(a, b)).toBe(false);
    }
  });

  it("puts every member at a desk inside its room, the manager alone in the back row", () => {
    const shop = layout.cells.find((c) => c.key === "shop")!;
    expect(shop.desks.map((d) => d.agentId).sort()).toEqual(["a", "b", "c", "d", "m1"]);
    const lead = shop.desks.find((d) => d.lead)!;
    expect(lead.agentId).toBe("m1");
    for (const d of shop.desks) {
      expect(inside(shop, d.seat.spot)).toBe(true);
      if (!d.lead) expect(d.center.z).toBeGreaterThan(lead.center.z);
    }
  });

  it("has a lounge spot for everyone waiting there", () => {
    const many = buildLayout(state([], 13));
    const lounge = many.cells.find((c) => c.key === LOUNGE)!;
    expect(lounge.lounge.length).toBe(13);
    for (const s of lounge.lounge) expect(inside(lounge, s.seat.spot)).toBe(true);
  });

  it("keeps the corridors outside every cell", () => {
    for (const cell of layout.cells) {
      for (const other of layout.cells) {
        expect(cell.laneX <= other.x || cell.laneX >= other.x + other.width).toBe(true);
        expect(cell.frontZ <= other.z || cell.frontZ >= other.z + other.depth).toBe(true);
      }
    }
  });
});

describe("route", () => {
  const layout = buildLayout(state([{ id: "shop", members: ["m1", "a", "b", "c", "d"], manager: "m1" }]));
  const shop = layout.cells.find((c) => c.key === "shop")!;
  const desk = (id: string) => shop.desks.find((d) => d.agentId === id)!;

  it("walks along aisles only: every leg is straight except the last step to the visitor spot", () => {
    const path = route(layout, desk("m1").seat, desk("d").visitor);
    expect(path[0]).toMatchObject({ x: desk("m1").seat.spot.x, z: desk("m1").seat.spot.z });
    expect(path.at(-1)).toMatchObject({ x: desk("d").visitor.spot.x, z: desk("d").visitor.spot.z });
    for (let i = 1; i < path.length - 1; i++) {
      const [a, b] = [path[i - 1]!, path[i]!];
      expect(Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.z - b.z) < 1e-9).toBe(true);
    }
  });

  it("goes out through the corridors to another cell", () => {
    const boss = layout.cells.find((c) => c.key === SUPER)!.desks[0]!;
    const path = route(layout, desk("a").seat, boss.visitor);
    expect(path.some((p) => Math.abs(p.x - shop.laneX) < 1e-9)).toBe(true);
    // No corridor point lies inside a cell other than at the two ends' aisles.
    for (const p of path.slice(2, -2)) {
      for (const cell of layout.cells) expect(inside(cell, p) && cell.desks.some((d) => d.center.x === p.x)).toBe(false);
    }
  });
});

/** Whether segment a-b crosses segment c-d (touching ends count). */
function crosses(a: Point, b: Point, c: Point, d: Point) {
  const side = (p: Point, q: Point, r: Point) => Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

describe("routes and walls", () => {
  const layout = buildLayout(
    state(
      [
        { id: "shop", members: ["m1", "a", "b", "c", "d", "e"], manager: "m1" },
        { id: "blog", members: ["m2", "a"], manager: "m2" },
        { id: "app", members: ["m3"], manager: "m3" },
        { id: "docs", members: ["b", "c", "x"] },
      ],
      9,
    ),
  );
  // Each cell's back wall and left wall, as lines along their inner faces.
  const walls = layout.cells.flatMap((c) => [
    [
      { x: c.x, z: c.z + 0.12 },
      { x: c.x + c.width, z: c.z + 0.12 },
    ],
    [
      { x: c.x + 0.12, z: c.z },
      { x: c.x + 0.12, z: c.z + c.depth },
    ],
  ]);
  const anchors = layout.cells.flatMap((c) => [
    ...c.desks.flatMap((d) => [d.seat, d.visitor]),
    ...c.lounge.flatMap((l) => [l.seat, l.visitor]),
  ]);

  it("never walks through a wall, between any two places in the office", () => {
    for (const from of anchors) {
      for (const to of anchors) {
        const path = route(layout, from, to);
        for (let i = 1; i < path.length; i++) {
          for (const [c, d] of walls) expect(crosses(path[i - 1]!, path[i]!, c!, d!)).toBe(false);
        }
      }
    }
  });
});
