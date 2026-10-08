import { describe, expect, it } from "vitest";
import {
  defaultMemoryLayer,
  layerTarget,
  memoryEditableBy,
  memoryLayer,
  memoryVisibleTo,
  type MemoryReader,
} from "./memory-scope";

const inProject = { agentId: "dev", projectId: "p1" };
const inOtherProject = { agentId: "dev", projectId: "p2" };
const outside = { agentId: "dev", projectId: null };
/** The super agent in the Telegram topic of p1: its notes on p1, never p1's team memory. */
const superInTopic = { agentId: "super", projectId: null, notesProjectId: "p1" };
const superOutside = { agentId: "super", projectId: null };

const global = { scope: "global" as const, agentId: null, projectId: null };
const craft = { scope: "agent" as const, agentId: "dev", projectId: null };
const someonesCraft = { scope: "agent" as const, agentId: "seo", projectId: null };
const myNotesP1 = { scope: "agent" as const, agentId: "dev", projectId: "p1" };
const myNotesP2 = { scope: "agent" as const, agentId: "dev", projectId: "p2" };
const someonesNotesP1 = { scope: "agent" as const, agentId: "seo", projectId: "p1" };
const teamP1 = { scope: "project" as const, agentId: "seo", projectId: "p1" };
const teamP2 = { scope: "project" as const, agentId: "dev", projectId: "p2" };
const superNotesP1 = { scope: "agent" as const, agentId: "super", projectId: "p1" };
const superNotesP2 = { scope: "agent" as const, agentId: "super", projectId: "p2" };
const superCraft = { scope: "agent" as const, agentId: "super", projectId: null };

/** Every entry and whether each reader sees it. */
const visibility: [string, Parameters<typeof memoryVisibleTo>[0], Record<string, boolean>][] = [
  ["global", global, { inProject: true, inOtherProject: true, outside: true, superInTopic: true, superOutside: true }],
  ["own craft", craft, { inProject: true, inOtherProject: true, outside: true, superInTopic: false, superOutside: false }],
  [
    "another agent's craft",
    someonesCraft,
    { inProject: false, inOtherProject: false, outside: false, superInTopic: false, superOutside: false },
  ],
  [
    "own notes on p1",
    myNotesP1,
    { inProject: true, inOtherProject: false, outside: false, superInTopic: false, superOutside: false },
  ],
  [
    "own notes on p2",
    myNotesP2,
    { inProject: false, inOtherProject: true, outside: false, superInTopic: false, superOutside: false },
  ],
  [
    "another agent's notes on p1",
    someonesNotesP1,
    { inProject: false, inOtherProject: false, outside: false, superInTopic: false, superOutside: false },
  ],
  [
    "team memory of p1",
    teamP1,
    { inProject: true, inOtherProject: false, outside: false, superInTopic: false, superOutside: false },
  ],
  [
    "team memory of p2",
    teamP2,
    { inProject: false, inOtherProject: true, outside: false, superInTopic: false, superOutside: false },
  ],
  [
    "the super agent's notes on p1",
    superNotesP1,
    { inProject: false, inOtherProject: false, outside: false, superInTopic: true, superOutside: false },
  ],
  [
    "the super agent's notes on p2",
    superNotesP2,
    { inProject: false, inOtherProject: false, outside: false, superInTopic: false, superOutside: false },
  ],
  [
    "the super agent's craft",
    superCraft,
    { inProject: false, inOtherProject: false, outside: false, superInTopic: true, superOutside: true },
  ],
];

const readers: Record<string, MemoryReader> = { inProject, inOtherProject, outside, superInTopic, superOutside };

describe("memoryVisibleTo", () => {
  for (const [name, memory, expected] of visibility) {
    it(`${name}: ${
      Object.entries(expected)
        .filter(([, seen]) => seen)
        .map(([reader]) => reader)
        .join(", ") || "nobody"
    }`, () => {
      for (const [reader, seen] of Object.entries(expected)) {
        expect([reader, memoryVisibleTo(memory, readers[reader]!)]).toEqual([reader, seen]);
      }
    });
  }

  it("a project run of another agent never reads this agent's notes on the same project", () => {
    expect(memoryVisibleTo(myNotesP1, { agentId: "seo", projectId: "p1" })).toBe(false);
  });

  it("a run in a project ignores a notes project: the run's project is the one", () => {
    expect(memoryVisibleTo(myNotesP2, { ...inProject, notesProjectId: "p2" })).toBe(false);
  });
});

describe("memoryEditableBy", () => {
  const editor = { ...inProject, isOrchestrator: false };

  it("leaves global memory to the orchestrator", () => {
    expect(memoryEditableBy(global, editor)).toBe(false);
    expect(memoryEditableBy(global, { ...superOutside, isOrchestrator: true })).toBe(true);
  });

  it("changes own craft, own notes and the team memory of the run's project only", () => {
    expect(memoryEditableBy(craft, editor)).toBe(true);
    expect(memoryEditableBy(myNotesP1, editor)).toBe(true);
    expect(memoryEditableBy(teamP1, editor)).toBe(true);
    expect(memoryEditableBy(myNotesP2, editor)).toBe(false);
    expect(memoryEditableBy(teamP2, editor)).toBe(false);
    expect(memoryEditableBy(someonesCraft, editor)).toBe(false);
    expect(memoryEditableBy(someonesNotesP1, editor)).toBe(false);
  });

  it("lets the orchestrator change its own notes on any project, nobody else's and no team memory", () => {
    const orchestrator = { ...superOutside, isOrchestrator: true };
    expect(memoryEditableBy(superNotesP1, orchestrator)).toBe(true);
    expect(memoryEditableBy(superNotesP2, orchestrator)).toBe(true);
    expect(memoryEditableBy(superCraft, orchestrator)).toBe(true);
    expect(memoryEditableBy(myNotesP1, orchestrator)).toBe(false);
    expect(memoryEditableBy(teamP1, orchestrator)).toBe(false);
  });
});

describe("memory layers", () => {
  it("names each entry's layer", () => {
    expect(memoryLayer(global)).toBe("global");
    expect(memoryLayer(craft)).toBe("craft");
    expect(memoryLayer(myNotesP1)).toBe("mine");
    expect(memoryLayer(teamP1)).toBe("team");
  });

  it("saves to the agent's notes inside a project and to its craft outside", () => {
    expect(defaultMemoryLayer("p1")).toBe("mine");
    expect(defaultMemoryLayer(null)).toBe("craft");
  });

  it("maps a layer to where it is stored", () => {
    expect(layerTarget("mine", "p1")).toEqual({ scope: "agent", projectId: "p1" });
    expect(layerTarget("team", "p1")).toEqual({ scope: "project", projectId: "p1" });
    expect(layerTarget("craft", "p1")).toEqual({ scope: "agent", projectId: null });
    expect(layerTarget("global", "p1")).toEqual({ scope: "global", projectId: null });
  });
});
