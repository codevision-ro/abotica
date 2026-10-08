/**
 * Pure rules of the background memory pipeline the worker runs: the journal and consolidation prompts,
 * the parser of consolidation's JSON lines, what a consolidated fact does to the entries it restates or
 * contradicts, how long an entry lasts and when it becomes permanent. No server imports, so they are
 * testable on their own; memory.ts and memory-retention.ts apply them.
 */
import { z } from "zod";
import type { memories } from "@abotica/db";

type Memory = typeof memories.$inferSelect;
export type MemoryRetention = Memory["retention"];

export const MEMORY_RETENTIONS = ["permanent", "durable", "ephemeral"] as const satisfies readonly MemoryRetention[];

/** How long an ephemeral entry holds after it became true (nanobot's period). */
export const EPHEMERAL_DAYS = 30;

/** A durable entry becomes permanent once memory_search returned it this often, for this many distinct queries (OpenClaw's defaults). */
export const PROMOTION_MIN_RECALLS = 3;
export const PROMOTION_MIN_QUERIES = 3;

/** Entries never recalled and older than this are listed on the memory page for cleanup (never deleted by themselves). */
export const NEVER_USED_DAYS = 60;

/** Existing entries consolidation compares its facts with. */
export const CONSOLIDATION_CANDIDATES = 10;

/** `flagReason` of a fact held because it contradicts an entry the user wrote. */
export const CONFLICTS_WITH_OWNER = "conflicts-with-owner";

const DAY_MS = 86_400_000;

/** A YYYY-MM-DD day that exists (not 2026-02-30). */
function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && dayStart(value).toISOString().startsWith(value);
}

const dayStart = (day: string) => new Date(`${day}T00:00:00Z`);

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

/** When an entry of this retention expires: ephemeral entries `EPHEMERAL_DAYS` after they became true (null: now). */
export function expiryFor(retention: MemoryRetention, validFrom: string | null, now: Date): Date | null {
  if (retention !== "ephemeral") return null;
  const from = validFrom ? dayStart(validFrom) : now;
  return new Date(from.getTime() + EPHEMERAL_DAYS * DAY_MS);
}

/** When an entry stopped being true: the day its replacement became true, never later than now. */
export function invalidationTime(validFrom: string | null, now: Date): Date {
  if (!validFrom) return now;
  const from = dayStart(validFrom);
  return from < now ? from : now;
}

/**
 * Whether an edit by an agent keeps the old text as history (a new entry replaces it) instead of
 * rewriting it: for entries agents or consolidation wrote. The user's entries and untrusted ones are
 * edited in place.
 */
export const keepsHistory = (origin: Memory["origin"]) => origin === "agent" || origin === "system";

/** What a journal or a consolidated fact is about. */
const scopeLine = (project: string | null | undefined) =>
  project ? `It covers only the work on the project "${project}".` : "It covers the work outside any project.";

const NO_RELATIVE_DATES =
  'Write every date as YYYY-MM-DD; never write "today", "yesterday", "tomorrow", "next week", "last Friday" or the like, in any language: the text is read days later.';

/** The prompt that writes an agent's journal of one day from the day's run log. */
export function journalPrompt(input: {
  day: string;
  timezone: string;
  language: string;
  project: string | null | undefined;
  log: string;
}) {
  return {
    instructions: [
      `You write the daily journal of an AI agent, in the first person, in ${input.language}. Be concise and concrete: at most 150 words, the decisions and what is still open first among what you keep.`,
      scopeLine(input.project),
      `Today is ${input.day} (time zone ${input.timezone}). ${NO_RELATIVE_DATES}`,
    ].join(" "),
    prompt: `Based on today's activity, write the journal with these sections (headings in ${input.language}):\n**What I did**\n**What I decided**\n**What is still open**\n**What I learned**\n\nLeave out empty sections.\n\n${input.log}`,
  };
}

/** An existing entry as consolidation shows it to the model. */
export type ConsolidationEntry = { content: string; validFrom: string | null; createdAt: Date };

/** The existing entries a consolidation prompt shows, with small integer ids instead of their UUIDs. */
const existingLines = (existing: readonly ConsolidationEntry[]) =>
  existing.map((entry, i) =>
    JSON.stringify({ id: i + 1, fact: entry.content, since: entry.validFrom ?? dayOf(entry.createdAt) }),
  );

/** How a consolidation answers, shared by the project and the craft prompts so one parser reads both. */
function answerFormat(existing: readonly ConsolidationEntry[], noun: string, known: readonly string[] = []): string[] {
  const shown = existingLines(existing);
  return [
    `Dates: each journal's heading is the day it was written. Resolve every relative date ("today", "yesterday", "next week", "last Friday", in any language) against that day. ${NO_RELATIVE_DATES}`,
    "",
    "Existing memory, to compare each one with by id:",
    ...(shown.length ? shown : ["(empty)"]),
    "",
    // Kept in the agent's other layers (the team's memory, its craft, the user's rules), which the
    // embedding check misses when the same fact is worded in another language or bundled with others.
    ...(known.length
      ? [
          `Already known in other memory layers: never restate these as a new ${noun}, in any language or wording:`,
          ...known.map((k) => `- ${k}`),
          "",
        ]
      : []),
    "Answer with one JSON object per line and nothing else (no Markdown, no code fence):",
    '{"fact": "...", "retention": "durable", "validFrom": "YYYY-MM-DD", "contradicts": [], "duplicates": null}',
    `- validFrom: the day the ${noun} became true, resolved against the day of its journal.`,
    `- duplicates: the id of the existing entry that already states the same information with the same values; the ${noun} is then not stored again. Otherwise null.`,
    `- contradicts: the ids of existing entries the ${noun} makes wrong (the same subject with another value, date or decision). Entries that differ in a number, a date or a qualifier are contradicted, never duplicates.`,
    'If there is nothing worth keeping, answer "NONE".',
  ];
}

/**
 * The prompt that turns journals into memory facts. Existing entries go in with small integer ids
 * (1, 2, ...) instead of their UUIDs, which a model copies wrong (mem0's anti-hallucination step);
 * `parseConsolidation` maps them back.
 */
export function consolidationPrompt(input: {
  language: string;
  project: string | null | undefined;
  journals: readonly { day: string; summary: string }[];
  existing: readonly ConsolidationEntry[];
  /** What other memory layers already hold, to leave out (see answerFormat). */
  known?: readonly string[];
}) {
  return {
    instructions: [
      "You maintain the long-term memory of an AI agent from its daily journals.",
      scopeLine(input.project),
      `Write the facts in ${input.language}.`,
    ].join(" "),
    prompt: [
      "Extract the facts worth keeping from the journals below. Keep a fact only if it passes all four tests:",
      "- Signal: remembering it saves the user from repeating it.",
      "- Novel: it adds something memory does not already hold.",
      "- Important: losing it would cause rework or lose a preference, a rule or a decision.",
      "- Persistent: it stays useful for at least two weeks.",
      "Leave out the state of the work: task status and progress, open to-dos and next steps, plans or proposals waiting for a decision, and ids of tasks or runs. Keep what will still be true and useful in two weeks: preferences, rules, decisions taken, how things are set up and how they behave.",
      // Outside projects, the name is what sends a project's fact to the notes on it (applyConsolidationOutsideProjects).
      ...(input.project ? [] : ["A fact about one project names the project."]),
      "",
      "The retention of each fact:",
      '- "permanent": the user\'s core preferences, traits and habits, true indefinitely.',
      '- "durable": project knowledge, decisions, technical discoveries and configuration, valid for months.',
      '- "ephemeral": temporary decisions and arrangements that may change within weeks (a deploy freeze this sprint, who covers a task this week).',
      "",
      ...answerFormat(input.existing, "fact", input.known),
      "",
      ...input.journals.map((j) => `## ${j.day}\n${j.summary}`),
    ].join("\n"),
  };
}

/**
 * The prompt that distils, from an agent's journals of one project, the lessons of its craft that hold
 * in any project: its profession improves while project facts stay with the project. `existing` is the
 * agent's own memory (its craft), which the lessons are compared with like facts. The project is named
 * only so the model knows what to leave out; namedProject still checks every lesson before it is stored.
 */
export function craftLessonsPrompt(input: {
  language: string;
  project: string;
  role: string;
  journals: readonly { day: string; summary: string }[];
  existing: readonly ConsolidationEntry[];
  /** What other memory layers already hold, to leave out (see answerFormat). */
  known?: readonly string[];
}) {
  return {
    instructions: [
      `You maintain the craft knowledge of an AI agent${input.role ? ` whose role is: ${input.role}` : ""}. It works on several projects for different clients; its craft knowledge is what it brings to every one of them.`,
      `The journals below cover only its work on the project "${input.project}".`,
      `Write the lessons in ${input.language}.`,
    ].join(" "),
    prompt: [
      "Extract only the lessons of the craft that would hold in any project, for any client: methods and techniques that worked or failed, how tools and platforms behave, pitfalls, quality checks worth doing, ways of working that saved time.",
      "Leave out everything specific to this project: its client, site, brand, product, audience, people, content, numbers, decisions, conventions, rules and preferences. A preference of this client or user is not a lesson of the craft, even if it is a good one. Task progress is not a lesson either.",
      "Write each lesson generically, so it reads the same in any project: never a name of a project, client, site, domain, product or person.",
      "When you are not sure a lesson holds in any project, leave it out. Most journals hold none; answering NONE is normal.",
      "",
      'The retention of each lesson: "durable" for a lesson of the craft, "ephemeral" for one tied to a tool version or a temporary condition (an API quirk that may be fixed).',
      "",
      ...answerFormat(input.existing, "lesson", input.known),
      "",
      ...input.journals.map((j) => `## ${j.day}\n${j.summary}`),
    ].join("\n"),
  };
}

/** An id the model was shown; lenient about a single id sent as a list. */
const ids = z.union([z.number().int(), z.array(z.number().int())]);

const factLine = z.object({
  fact: z.string().trim().min(6),
  retention: z.enum(MEMORY_RETENTIONS),
  // A wrong day loses the date, not the fact: it then holds since it was stored.
  validFrom: z
    .string()
    .refine(isDay)
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  contradicts: ids.nullish(),
  duplicates: ids.nullish(),
});

/** A fact of consolidation's answer; `contradicts` and `duplicates` are the integer ids of the prompt. */
export type ConsolidatedFact = {
  content: string;
  retention: MemoryRetention;
  validFrom: string | null;
  contradicts: number[];
  duplicates: number | null;
};

/**
 * Consolidation's answer, one JSON object per line (see consolidationPrompt). A line that is not JSON or
 * lacks the fact or its retention is skipped and counted in `malformed`; blank lines, "NONE" and code fences
 * are not. Ids outside 1..`existingCount` were never shown to the model and are dropped.
 */
export function parseConsolidation(
  output: string,
  existingCount: number,
): { facts: ConsolidatedFact[]; malformed: number } {
  const known = (value: number | number[] | null | undefined) =>
    [...new Set([value ?? []].flat())].filter((id) => id >= 1 && id <= existingCount);
  const facts: ConsolidatedFact[] = [];
  let malformed = 0;
  for (const raw of output.split("\n")) {
    const line = raw.trim().replace(/^-\s+(?=\{)/, "");
    if (!line || line.startsWith("```") || /^none\.?$/i.test(line)) continue;
    const parsed = factLine.safeParse(parseJson(line));
    if (!parsed.success) {
      malformed++;
      continue;
    }
    const { fact, retention, validFrom, contradicts, duplicates } = parsed.data;
    facts.push({
      content: fact,
      retention,
      validFrom,
      contradicts: known(contradicts),
      duplicates: known(duplicates)[0] ?? null,
    });
  }
  return { facts, malformed };
}

/**
 * Whether consolidation's answer gave nothing to go on: no fact, and lines that could not be read or no
 * answer at all. Its journals are then left to the next consolidation rather than lost; "NONE" is an answer.
 */
export const unreadableConsolidation = (output: string, parsed: { facts: unknown[]; malformed: number }): boolean =>
  parsed.facts.length === 0 && (parsed.malformed > 0 || !output.trim());

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** An existing entry consolidation showed the model, in the order of its integer ids. */
export type RelatedEntry = { id: string; origin: Memory["origin"]; source: string };

/**
 * What a consolidated fact does:
 * - it restates an entry: nothing is stored. A consolidated entry is refreshed (it was confirmed again),
 *   unless the fact came from untrusted journals; the text stays as it was, so nothing is lost;
 * - otherwise it is a new entry that replaces the entries it contradicts. An entry the user wrote is never
 *   replaced without the user: the new entry then waits for approval (`conflictsWithOwner`).
 */
export type FactPlan =
  | { kind: "restated"; entryId: string; refresh: boolean }
  | { kind: "new"; replaces: string[]; conflictsWithOwner: boolean };

export function planFact(
  fact: ConsolidatedFact,
  related: readonly RelatedEntry[],
  origin: "system" | "untrusted",
): FactPlan {
  const entry = (id: number) => related[id - 1];
  const restated = fact.duplicates === null ? undefined : entry(fact.duplicates);
  if (restated) {
    return {
      kind: "restated",
      entryId: restated.id,
      refresh: restated.source === "consolidation" && origin === "system",
    };
  }
  const contradicted = fact.contradicts.flatMap((id) => entry(id) ?? []);
  return {
    kind: "new",
    replaces: contradicted.map((e) => e.id),
    conflictsWithOwner: contradicted.some((e) => e.origin === "owner"),
  };
}

/** How memory_search used an entry, for promotion. */
export type RecallStats = {
  retention: MemoryRetention;
  origin: Memory["origin"];
  searchRecalls: number;
  distinctQueries: number;
};

/**
 * Whether a durable entry becomes permanent (exempt from decay in search): memory_search returned it
 * often enough, for enough distinct queries. Untrusted content is never promoted.
 */
export function promotable(stats: RecallStats): boolean {
  return (
    stats.retention === "durable" &&
    stats.origin !== "untrusted" &&
    stats.searchRecalls >= PROMOTION_MIN_RECALLS &&
    stats.distinctQueries >= PROMOTION_MIN_QUERIES
  );
}
