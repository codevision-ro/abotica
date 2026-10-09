import { describe, expect, it } from "vitest";
import {
  consolidationPrompt,
  craftLessonsPrompt,
  expiryFor,
  invalidationTime,
  journalPrompt,
  keepsHistory,
  parseConsolidation,
  planFact,
  promotable,
  type RelatedEntry,
  unreadableConsolidation,
} from "./memory-consolidation";

const NOW = new Date("2026-10-08T21:45:00Z");

describe("journalPrompt", () => {
  const prompt = journalPrompt({
    day: "2026-10-08",
    timezone: "Europe/Bucharest",
    language: "Romanian",
    project: "Shop",
    log: "## Run 10:15 (chat, succeeded)\nRequest: move the release to next Monday",
  });

  it("gives the day and time zone and asks for absolute dates only", () => {
    expect(prompt.instructions).toContain("Today is 2026-10-08 (time zone Europe/Bucharest).");
    expect(prompt.instructions).toContain("Write every date as YYYY-MM-DD");
    for (const relative of ["today", "yesterday", "next week"]) {
      expect(prompt.instructions).toContain(`"${relative}"`);
    }
  });

  it("keeps the language, the project and the log", () => {
    expect(prompt.instructions).toContain("in Romanian");
    expect(prompt.instructions).toContain('the project "Shop"');
    expect(prompt.prompt).toContain("Request: move the release to next Monday");
  });
});

describe("consolidationPrompt", () => {
  const prompt = consolidationPrompt({
    language: "English",
    project: null,
    journals: [
      { day: "2026-10-06", summary: "Agreed the release is on 2026-10-20." },
      { day: "2026-10-08", summary: "The release moved to next Monday." },
    ],
    existing: [
      { content: "The release is on 2026-10-20.", validFrom: "2026-10-01", createdAt: new Date("2026-10-02T09:00:00Z") },
      { content: "The client prefers short reports.", validFrom: null, createdAt: new Date("2026-09-15T09:00:00Z") },
    ],
  });

  it("shows existing entries with small integer ids, never their UUIDs", () => {
    expect(prompt.prompt).toContain('{"id":1,"fact":"The release is on 2026-10-20.","since":"2026-10-01"}');
    expect(prompt.prompt).toContain('{"id":2,"fact":"The client prefers short reports.","since":"2026-09-15"}');
  });

  it("dates each journal and asks to resolve relative dates against it", () => {
    expect(prompt.prompt).toContain("## 2026-10-06\nAgreed the release is on 2026-10-20.");
    expect(prompt.prompt).toContain("## 2026-10-08\nThe release moved to next Monday.");
    expect(prompt.prompt).toMatch(/Resolve every relative date .* against that day/);
    expect(prompt.prompt).toContain("Write every date as YYYY-MM-DD");
  });

  it("asks for JSON lines with retention, validity and the ids a fact restates or replaces", () => {
    for (const field of ['"retention"', '"validFrom"', '"contradicts"', '"duplicates"']) {
      expect(prompt.prompt).toContain(field);
    }
    for (const retention of ['"permanent"', '"durable"', '"ephemeral"']) expect(prompt.prompt).toContain(retention);
  });

  it("leaves out the state of the work, and asks facts outside projects to name their project", () => {
    expect(prompt.prompt).toMatch(/Leave out the state of the work: task status .* ids of tasks or runs/);
    expect(prompt.prompt).toContain("A fact about one project names the project.");
    const inProject = consolidationPrompt({ language: "English", project: "Shop", journals: [], existing: [] });
    expect(inProject.prompt).not.toContain("names the project");
  });

  it("says when memory holds nothing to compare with", () => {
    const empty = consolidationPrompt({ language: "English", project: "Shop", journals: [], existing: [] });
    expect(empty.prompt).toContain("(empty)");
    expect(empty.instructions).toContain('the project "Shop"');
  });
});

describe("parseConsolidation", () => {
  const line = (fact: Record<string, unknown>) => JSON.stringify(fact);

  it("parses one fact per line, ids and all", () => {
    const output = [
      line({ fact: "The release moved to 2026-11-02.", retention: "durable", validFrom: "2026-10-08", contradicts: [1] }),
      line({ fact: "The client prefers short reports.", retention: "permanent", validFrom: null, duplicates: 2 }),
    ].join("\n");
    expect(parseConsolidation(output, 2)).toEqual({
      malformed: 0,
      facts: [
        {
          content: "The release moved to 2026-11-02.",
          retention: "durable",
          validFrom: "2026-10-08",
          contradicts: [1],
          duplicates: null,
        },
        {
          content: "The client prefers short reports.",
          retention: "permanent",
          validFrom: null,
          contradicts: [],
          duplicates: 2,
        },
      ],
    });
  });

  it("skips and counts malformed lines without failing", () => {
    const output = [
      "Here are the facts:",
      line({ fact: "Deploys are frozen until 2026-10-20.", retention: "ephemeral", validFrom: "2026-10-08" }),
      '{"fact": "Broken JSON", "retention": ',
      line({ fact: "No retention given at all." }),
      line({ fact: "Unknown class.", retention: "forever" }),
      line({ fact: "ok", retention: "durable" }),
      line({ retention: "durable" }),
      "[1, 2]",
    ].join("\n");
    const { facts, malformed } = parseConsolidation(output, 0);
    expect(facts.map((f) => f.content)).toEqual(["Deploys are frozen until 2026-10-20."]);
    expect(malformed).toBe(7);
  });

  it("does not count blank lines, NONE or code fences as malformed", () => {
    expect(parseConsolidation("NONE", 3)).toEqual({ facts: [], malformed: 0 });
    const fenced = ["```json", line({ fact: "Releases ship on Tuesdays.", retention: "durable" }), "```", ""].join("\n");
    expect(parseConsolidation(fenced, 0)).toMatchObject({
      malformed: 0,
      facts: [{ content: "Releases ship on Tuesdays." }],
    });
  });

  it("drops ids the model was never shown and keeps the fact", () => {
    const output = line({
      fact: "The release moved to 2026-11-02.",
      retention: "durable",
      contradicts: [0, 1, 1, 7],
      duplicates: 9,
    });
    expect(parseConsolidation(output, 2).facts).toEqual([expect.objectContaining({ contradicts: [1], duplicates: null })]);
  });

  it("accepts a single id sent as a list", () => {
    const output = line({
      fact: "The client prefers short reports.",
      retention: "permanent",
      duplicates: [2],
      contradicts: 1,
    });
    expect(parseConsolidation(output, 2).facts).toEqual([expect.objectContaining({ contradicts: [1], duplicates: 2 })]);
  });

  it("keeps a fact with a wrong day, without the day", () => {
    for (const validFrom of ["2026-02-30", "next week", "08.10.2026", 20261008]) {
      const output = line({ fact: "Releases ship on Tuesdays.", retention: "durable", validFrom });
      expect(parseConsolidation(output, 0).facts).toEqual([expect.objectContaining({ validFrom: null })]);
    }
  });
});

describe("unreadableConsolidation", () => {
  const unreadable = (output: string) => unreadableConsolidation(output, parseConsolidation(output, 0));

  it("is true for an empty answer and for one whose lines could not be read", () => {
    expect(unreadable("")).toBe(true);
    expect(unreadable("  \n")).toBe(true);
    expect(unreadable("Here are the facts I found:\n- Deploys go to Hetzner.")).toBe(true);
  });

  it('is false for "NONE" and for an answer with facts, even beside a malformed line', () => {
    expect(unreadable("NONE")).toBe(false);
    expect(unreadable(`${JSON.stringify({ fact: "Releases ship on Tuesdays.", retention: "durable" })}\nnot json`)).toBe(
      false,
    );
  });
});

describe("planFact", () => {
  const related: RelatedEntry[] = [
    { id: "m-consolidated", origin: "system", source: "consolidation" },
    { id: "m-owner", origin: "owner", source: "manual" },
    { id: "m-agent", origin: "agent", source: "agent" },
  ];
  const fact = (over: { contradicts?: number[]; duplicates?: number | null }) => ({
    content: "The release moved to 2026-11-02.",
    retention: "durable" as const,
    validFrom: "2026-10-08",
    contradicts: over.contradicts ?? [],
    duplicates: over.duplicates ?? null,
  });

  it("replaces a contradicted consolidated entry with the new fact", () => {
    expect(planFact(fact({ contradicts: [1] }), related, "system")).toEqual({
      kind: "new",
      replaces: ["m-consolidated"],
      conflictsWithOwner: false,
    });
  });

  it("holds a fact that contradicts the user's entry for approval", () => {
    expect(planFact(fact({ contradicts: [2, 3] }), related, "system")).toEqual({
      kind: "new",
      replaces: ["m-owner", "m-agent"],
      conflictsWithOwner: true,
    });
  });

  it("stores nothing for a restated fact; a trusted one refreshes a consolidated entry", () => {
    expect(planFact(fact({ duplicates: 1, contradicts: [3] }), related, "system")).toEqual({
      kind: "restated",
      entryId: "m-consolidated",
      refresh: true,
    });
    expect(planFact(fact({ duplicates: 1 }), related, "untrusted")).toMatchObject({ refresh: false });
    expect(planFact(fact({ duplicates: 3 }), related, "system")).toMatchObject({ entryId: "m-agent", refresh: false });
  });

  it("is a plain new fact without ids", () => {
    expect(planFact(fact({}), related, "system")).toEqual({ kind: "new", replaces: [], conflictsWithOwner: false });
  });
});

describe("retention", () => {
  it("gives ephemeral entries the configured days from when they became true", () => {
    expect(expiryFor("ephemeral", "2026-10-08", NOW, 30)).toEqual(new Date("2026-11-07T00:00:00Z"));
    expect(expiryFor("ephemeral", null, NOW, 30)).toEqual(new Date("2026-11-07T21:45:00Z"));
    expect(expiryFor("ephemeral", "2026-10-08", NOW, 7)).toEqual(new Date("2026-10-15T00:00:00Z"));
    expect(expiryFor("durable", "2026-10-08", NOW, 30)).toBeNull();
    expect(expiryFor("permanent", null, NOW, 30)).toBeNull();
  });

  it("invalidates from the day the replacement became true, never in the future", () => {
    expect(invalidationTime("2026-10-06", NOW)).toEqual(new Date("2026-10-06T00:00:00Z"));
    expect(invalidationTime("2026-11-02", NOW)).toEqual(NOW);
    expect(invalidationTime(null, NOW)).toEqual(NOW);
  });

  it("keeps history for what agents wrote, edits the user's and untrusted entries in place", () => {
    expect(keepsHistory("agent")).toBe(true);
    expect(keepsHistory("system")).toBe(true);
    expect(keepsHistory("owner")).toBe(false);
    expect(keepsHistory("untrusted")).toBe(false);
  });
});

describe("promotable", () => {
  const stats = { retention: "durable" as const, origin: "system" as const, searchRecalls: 3, distinctQueries: 3 };

  it("promotes a durable entry searched 3 times by 3 distinct queries", () => {
    expect(promotable(stats)).toBe(true);
    expect(promotable({ ...stats, origin: "agent", searchRecalls: 7 })).toBe(true);
  });

  it("needs both enough recalls and enough distinct queries", () => {
    expect(promotable({ ...stats, searchRecalls: 2 })).toBe(false);
    expect(promotable({ ...stats, searchRecalls: 9, distinctQueries: 2 })).toBe(false);
  });

  it("never promotes untrusted content, and only durable entries", () => {
    expect(promotable({ ...stats, origin: "untrusted", searchRecalls: 10, distinctQueries: 10 })).toBe(false);
    expect(promotable({ ...stats, retention: "ephemeral" })).toBe(false);
    expect(promotable({ ...stats, retention: "permanent" })).toBe(false);
  });
});

describe("craftLessonsPrompt", () => {
  const prompt = craftLessonsPrompt({
    language: "English",
    project: "Shop",
    role: "SEO specialist",
    journals: [{ day: "2026-10-08", summary: "Titles under 60 characters kept their full text in results." }],
    existing: [
      { content: "Check the SERP before writing a brief.", validFrom: null, createdAt: new Date("2026-10-01T09:00:00Z") },
    ],
  });

  it("names the project only as the scope to leave out, and the role whose craft it keeps", () => {
    expect(prompt.instructions).toContain('only its work on the project "Shop"');
    expect(prompt.instructions).toContain("whose role is: SEO specialist");
    expect(prompt.prompt).toMatch(/Leave out everything specific to this project/);
    expect(prompt.prompt).toMatch(/never a name of a project, client, site/);
  });

  it("compares lessons with the agent's own entries and answers like a consolidation, so one parser reads it", () => {
    expect(prompt.prompt).toContain('{"id":1,"fact":"Check the SERP before writing a brief.","since":"2026-10-01"}');
    for (const field of ['"retention"', '"validFrom"', '"contradicts"', '"duplicates"']) {
      expect(prompt.prompt).toContain(field);
    }
    expect(prompt.prompt).not.toContain('"permanent"');
    expect(
      parseConsolidation('{"fact": "Short titles keep their full text.", "retention": "durable"}', 1).facts,
    ).toHaveLength(1);
  });
});

describe("consolidation and what other layers already hold", () => {
  const journals = [{ day: "2026-10-08", summary: "Publishing pace confirmed." }];

  it("lists them as already known, to leave out in any language", () => {
    const prompt = consolidationPrompt({
      language: "English",
      project: "Shop",
      journals,
      existing: [],
      known: ["Ritm de publicare: 2 articole pe zi."],
    });
    expect(prompt.prompt).toContain("never restate these as a new fact, in any language or wording:");
    expect(prompt.prompt).toContain("- Ritm de publicare: 2 articole pe zi.");
  });

  it("says nothing about them when there are none", () => {
    const prompt = consolidationPrompt({ language: "English", project: "Shop", journals, existing: [] });
    expect(prompt.prompt).not.toContain("Already known in other memory layers");
  });
});
