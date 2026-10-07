import { describe, expect, it } from "vitest";
import { groupByJournal, journalHeading, splitByProject, verbatimJournals } from "./journal-groups";

describe("groupByJournal", () => {
  it("keeps one group per agent and project, in order of first appearance", () => {
    const runs = [
      { id: "1", agentId: "a", projectId: "p1" },
      { id: "2", agentId: "a", projectId: null },
      { id: "3", agentId: "b", projectId: "p1" },
      { id: "4", agentId: "a", projectId: "p1" },
      { id: "5", agentId: "a", projectId: "p2" },
      { id: "6", agentId: "a", projectId: null },
    ];
    expect(groupByJournal(runs).map((g) => ({ ...g, items: g.items.map((r) => r.id) }))).toEqual([
      { agentId: "a", projectId: "p1", items: ["1", "4"] },
      { agentId: "a", projectId: null, items: ["2", "6"] },
      { agentId: "b", projectId: "p1", items: ["3"] },
      { agentId: "a", projectId: "p2", items: ["5"] },
    ]);
  });

  it("returns nothing for no items", () => {
    expect(groupByJournal([])).toEqual([]);
  });
});

describe("journalHeading", () => {
  it("names the project next to the agent when the journal has one", () => {
    expect(journalHeading({ agent: "Ana", project: "Shop", day: "2026-10-06" })).toBe("## Ana, project Shop (2026-10-06)");
    expect(journalHeading({ agent: "Ana", project: null, day: "2026-10-06" })).toBe("## Ana (2026-10-06)");
  });
});

describe("splitByProject", () => {
  it("keeps the items of closed projects out of the open ones, in order", () => {
    const items = [
      { id: "1", projectId: "open" },
      { id: "2", projectId: "closed" },
      { id: "3", projectId: null },
      { id: "4", projectId: "closed" },
    ];
    const { open, closed } = splitByProject(items, new Set(["closed"]));
    expect(open.map((i) => i.id)).toEqual(["1", "3"]);
    expect(closed.map((i) => i.id)).toEqual(["2", "4"]);
  });

  it("leaves everything open when no project is closed", () => {
    const items = [{ projectId: "p" }, { projectId: null }];
    expect(splitByProject(items, new Set())).toEqual({ open: items, closed: [] });
  });
});

describe("verbatimJournals", () => {
  it("lists the journals as written, under the heading", () => {
    const journals = [
      { agent: "Ana", project: "Clinic", day: "2026-10-06", summary: "Filed the report." },
      { agent: "Bob", project: "Clinic", day: "2026-10-07", summary: "Called the lab." },
    ];
    expect(verbatimJournals("Restricted", journals)).toBe(
      "**Restricted**\n\n**Clinic · Ana (2026-10-06)**\nFiled the report.\n\n**Clinic · Bob (2026-10-07)**\nCalled the lab.",
    );
  });

  it("is null without journals", () => {
    expect(verbatimJournals("Restricted", [])).toBeNull();
  });
});
