import type { OfficeInteraction, OfficeState } from "@abotica/core/office";
import { describe, expect, it } from "vitest";
import { Director, type Home } from "./director";
import { buildLayout, LOUNGE, type OfficeLayout, SUPER } from "./layout";

const office: OfficeState = {
  agents: [],
  superAgent: { agentId: "boss", seat: null },
  rooms: [
    {
      projectId: "shop",
      name: "Shop",
      status: "active",
      managerAgentId: "lead",
      memberIds: ["lead", "dev"],
      seats: [],
    },
  ],
  loungeIds: ["dev"],
  interactions: [],
  generatedAt: new Date(0).toISOString(),
};

function homes(layout: OfficeLayout, at: { agentId: string; cell: string }[]): Home[] {
  return at.map(({ agentId, cell }) => {
    const c = layout.cells.find((x) => x.key === cell)!;
    if (cell === LOUNGE) {
      const spot = c.lounge[0]!;
      return {
        key: `${agentId}@${cell}`,
        agentId,
        cell,
        anchor: spot.seat,
        visitor: spot.visitor,
        pose: spot.kind,
        desk: null,
      };
    }
    const desk = c.desks.find((d) => d.agentId === agentId)!;
    return { key: `${agentId}@${cell}`, agentId, cell, anchor: desk.seat, visitor: desk.visitor, pose: "desk", desk };
  });
}

const interaction = (patch: Partial<OfficeInteraction>): OfficeInteraction => ({
  id: "i1",
  at: new Date(0).toISOString(),
  kind: "delegated",
  fromAgentId: "lead",
  toAgentId: "dev",
  projectId: "shop",
  task: { id: "t1", title: "Fix the cart" },
  text: null,
  ...patch,
});

/** Runs the director for `seconds` at 60 frames a second. */
function run(director: Director, seconds: number, start = 0) {
  let now = start;
  for (let i = 0; i < seconds * 60; i++) {
    now += 1000 / 60;
    director.update(1 / 60, now);
  }
  return now;
}

describe("Director", () => {
  const layout = buildLayout(office);
  const seated = homes(layout, [
    { agentId: "boss", cell: SUPER },
    { agentId: "lead", cell: "shop" },
    { agentId: "dev", cell: "shop" },
  ]);

  it("walks over, says it, and walks back home", () => {
    const director = new Director(layout);
    director.sync(seated, layout);
    let now = run(director, 1);
    director.play(interaction({ text: "Please fix the cart" }), now);
    now = run(director, 0.1, now);
    const lead = director.runtimes.get("lead@shop")!;
    expect(lead.act).toBe("walk");
    expect(lead.carry).toBe(true);

    let said = false;
    for (let t = 0; t < 40 && !(said && lead.act === "home"); t++) {
      now = run(director, 0.5, now);
      if (director.bubbles.get("lead@shop")?.text === "Please fix the cart") said = true;
    }
    expect(said).toBe(true);
    expect(lead.act).toBe("home");
    expect(lead.trip).toBeNull();
    expect(director.bubbles.has("lead@shop")).toBe(false);
    expect([lead.x, lead.z]).toEqual([lead.home.anchor.spot.x, lead.home.anchor.spot.z]);
  });

  it("puts work from the user on the desk, without anyone walking", () => {
    const director = new Director(layout);
    director.sync(seated, layout);
    const now = run(director, 1);
    director.play(interaction({ fromAgentId: null }), now);
    run(director, 0.1, now);
    expect(director.effects.map((e) => e.kind)).toEqual(["drop"]);
    expect(director.bubbles.get("dev@shop")?.kind).toBe("delegated");
    expect(director.runtimes.get("dev@shop")!.act).toBe("home");
  });

  it("has the super agent take a question for the user on the phone", () => {
    const director = new Director(layout);
    director.sync(seated, layout);
    let now = run(director, 1);
    director.play(interaction({ kind: "question", fromAgentId: "lead", toAgentId: null }), now);
    let phoned = false;
    for (let t = 0; t < 60 && !phoned; t++) {
      now = run(director, 0.25, now);
      phoned = director.runtimes.get("boss@super")!.phoneUntil > now;
    }
    expect(phoned).toBe(true);
    expect(director.bubbles.get("boss@super")?.phone).toBe(true);
  });

  it("walks someone from the lounge to the desk they got work at", () => {
    const director = new Director(layout);
    director.sync(homes(layout, [{ agentId: "dev", cell: LOUNGE }]), layout);
    let now = run(director, 1);
    const before = director.runtimes.get("dev@lounge")!;
    const from = { x: before.x, z: before.z };
    director.sync(homes(layout, [{ agentId: "dev", cell: "shop" }]), layout);
    const dev = director.runtimes.get("dev@shop")!;
    expect(director.runtimes.has("dev@lounge")).toBe(false);
    expect({ x: dev.x, z: dev.z }).toEqual(from);
    expect(dev.act).toBe("walk");
    for (let t = 0; t < 40 && dev.act !== "home"; t++) now = run(director, 0.5, now);
    expect(dev.act).toBe("home");
    expect([dev.x, dev.z]).toEqual([dev.home.anchor.spot.x, dev.home.anchor.spot.z]);
  });

  it("puts everyone straight at home when the floor plan changes, instead of walking through new walls", () => {
    const director = new Director(layout);
    director.sync(seated, layout);
    let now = run(director, 1);
    director.play(interaction({}), now);
    now = run(director, 0.5, now);
    expect(director.runtimes.get("lead@shop")!.act).toBe("walk");

    const bigger = buildLayout({
      ...office,
      rooms: [...office.rooms, { ...office.rooms[0]!, projectId: "blog", name: "Blog", memberIds: [] }],
    });
    director.sync(
      homes(bigger, [
        { agentId: "boss", cell: SUPER },
        { agentId: "lead", cell: "shop" },
        { agentId: "dev", cell: "shop" },
      ]),
      bigger,
    );
    for (const r of director.runtimes.values()) {
      expect(r.act).toBe("home");
      expect([r.x, r.z]).toEqual([r.home.anchor.spot.x, r.home.anchor.spot.z]);
    }
    expect(director.bubbles.size).toBe(0);
  });

  it("finishes the way it is on before walking to a new home, so it never cuts across", () => {
    const director = new Director(layout);
    director.sync(seated, layout);
    let now = run(director, 1);
    director.play(interaction({ text: "go" }), now);
    now = run(director, 0.3, now);
    const lead = director.runtimes.get("lead@shop")!;
    expect(lead.act).toBe("walk");
    const visitor = lead.at;
    // The lead goes idle mid-walk: its home becomes the lounge.
    const lounge = layout.cells.find((c) => c.key === LOUNGE)!.lounge[0]!;
    director.sync(
      [
        ...seated.filter((h) => h.agentId !== "lead"),
        {
          key: "lead@lounge",
          agentId: "lead",
          cell: LOUNGE,
          anchor: lounge.seat,
          visitor: lounge.visitor,
          pose: "sofa",
          desk: null,
        },
      ],
      layout,
    );
    const moved = director.runtimes.get("lead@lounge")!;
    expect(moved.at).toBe(visitor);
    for (let t = 0; t < 80 && moved.act !== "home"; t++) now = run(director, 0.5, now);
    expect(moved.act).toBe("home");
    expect([moved.x, moved.z]).toEqual([lounge.seat.spot.x, lounge.seat.spot.z]);
  });

  it("keeps one thing at a time per person, in order", () => {
    const director = new Director(layout);
    director.sync(seated, layout);
    const now = run(director, 1);
    director.play(interaction({ id: "a", kind: "question", text: "first" }), now);
    director.play(interaction({ id: "b", kind: "instruction", text: "second" }), now);
    const lead = director.runtimes.get("lead@shop")!;
    run(director, 0.1, now);
    expect(lead.trip?.type === "visit" && lead.trip.interaction.id).toBe("a");
    expect(lead.queue.map((t) => (t.type === "move" ? null : t.interaction.id))).toEqual(["b"]);
  });
});
