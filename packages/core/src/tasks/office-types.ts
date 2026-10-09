/**
 * The office view of the company: who sits where, what each agent is doing now, and the latest
 * interactions between them. Built in core (tasks/office.ts), drawn by the web office page.
 * Client components import this file; keep it free of runtime imports.
 */
import type { AgentAvatar } from "@abotica/db/avatar";

export type OfficeAgentKind = "orchestrator" | "manager" | "specialist";

export type OfficeAgent = {
  id: string;
  name: string;
  role: string;
  kind: OfficeAgentKind;
  avatar: AgentAvatar;
};

/**
 * What an agent is doing in one place, most urgent first when several apply:
 * `needs_you` (a run waits for an approval, or its question waits for the user), `working` (a run is
 * queued or running), `blocked` (a task of its is blocked), `waiting` (its task is in progress with no
 * run: waiting for an answer, a colleague or a wakeup), `idle`.
 */
export type OfficeStatus = "needs_you" | "working" | "blocked" | "waiting" | "idle";

/** What is on the monitor while a run works, from the tools of its latest step. */
export type OfficeActivity = "terminal" | "browser" | "writing" | "talking" | "thinking";

export type OfficeTaskRef = { id: string; title: string };

/** An agent at its desk in a room: one per agent per project it has work in. */
export type OfficeSeat = {
  agentId: string;
  status: Exclude<OfficeStatus, "idle">;
  /** Set while working. */
  activity: OfficeActivity | null;
  /** The task it is on (the most urgent one when it has several in the room). */
  task: OfficeTaskRef | null;
  /** When the current status started, ISO. */
  since: string;
};

export type OfficeRoom = {
  projectId: string;
  name: string;
  status: "active" | "paused";
  managerAgentId: string | null;
  /** Manager first, then the team, by name: each has a desk in the room. */
  memberIds: string[];
  /** Who sits at a desk now; a member without a seat is idle (in the lounge). */
  seats: OfficeSeat[];
};

export type OfficeInteractionKind =
  /** Work given: a task delegated or created for someone. */
  | "delegated"
  /** A colleague asked for help (ask_colleague). */
  | "help"
  | "question"
  | "answer"
  /** A question passed up the chain. */
  | "escalated"
  | "instruction"
  | "progress"
  /** Finished work reported back to whoever gave it. */
  | "report"
  /** Files handed from a finished task to the one that depends on it. */
  | "handoff"
  /** Put aside for more urgent work. */
  | "put_aside"
  | "paused"
  | "resumed"
  | "cancelled"
  | "redirected";

export type OfficeInteraction = {
  /** Stable across reads, so the page animates each interaction once. */
  id: string;
  at: string;
  kind: OfficeInteractionKind;
  /** Null: the user (the platform's own steps are not interactions). */
  fromAgentId: string | null;
  /** Null: the user. */
  toAgentId: string | null;
  /** The room it happens in; null for the super agent's own work. */
  projectId: string | null;
  task: OfficeTaskRef;
  /** A short excerpt: the question, the instruction, the reason. */
  text: string | null;
};

export type OfficeState = {
  /** Every agent that appears anywhere below. */
  agents: OfficeAgent[];
  /** The super agent at its own desk; null when there is none. */
  superAgent: { agentId: string; seat: OfficeSeat | null } | null;
  rooms: OfficeRoom[];
  /** Agents with no seat anywhere: they wait in the lounge. Excludes the super agent. */
  loungeIds: string[];
  /** Newest first, at most 40, from the last 24 hours. */
  interactions: OfficeInteraction[];
  /** When this state was read, ISO. */
  generatedAt: string;
};
