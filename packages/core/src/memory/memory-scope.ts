/**
 * Which memory a run reads and changes. Pure: memory.ts builds the same rule as SQL, the memory
 * tools apply it to single entries. The layers:
 * - global (scope global): the user's rules and preferences, read by every agent;
 * - an agent's craft (scope agent, no project): its own, read in every project and outside projects;
 * - an agent's notes on a project (scope agent with the project): its own, read only in that project;
 * - a project's team memory (scope project): shared by the whole team of the project.
 */

type Scoped = { scope: "global" | "project" | "agent"; agentId: string | null; projectId: string | null };

/**
 * The run asking: its agent and the one project it works in (null outside projects). The super agent
 * never works in one: `notesProjectId` is the project whose notes it reads (the one its Telegram topic
 * belongs to, or the one memory_search names), without that project's team memory.
 */
export type MemoryReader = { agentId: string; projectId: string | null; notesProjectId?: string | null };

/** The project whose notes of the agent a run reads: the run's project, or the super agent's notes project. */
export const notesProject = (reader: MemoryReader): string | null => reader.projectId ?? reader.notesProjectId ?? null;

/**
 * Global memory, the agent's craft, and of projects only the run's: an agent on several projects never
 * reads another project's team memory or its own notes on another project in this one. Team memory is
 * shared by the team, whoever wrote it; another agent's notes are never read.
 */
export function memoryVisibleTo(memory: Scoped, reader: MemoryReader): boolean {
  if (memory.scope === "global") return true;
  if (memory.scope === "agent") {
    return memory.agentId === reader.agentId && (memory.projectId === null || memory.projectId === notesProject(reader));
  }
  return reader.projectId !== null && memory.projectId === reader.projectId;
}

/**
 * Agents change what they could have written: their own memory and the team memory of the run's project.
 * Global memory holds the user's facts and preferences, so only the orchestrator changes it; the
 * orchestrator writes notes on any project, so it changes its own notes on any of them.
 */
export function memoryEditableBy(memory: Scoped, editor: MemoryReader & { isOrchestrator: boolean }): boolean {
  if (memory.scope === "global") return editor.isOrchestrator;
  if (memory.scope === "agent" && editor.isOrchestrator) return memory.agentId === editor.agentId;
  return memoryVisibleTo(memory, editor);
}

/**
 * The layers as the memory tools name them, from the agent's side: global, craft (its own memory that
 * holds in any project), mine (its notes on the project) and team (the project's shared memory).
 */
export const MEMORY_LAYERS = ["mine", "team", "craft", "global"] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

export function memoryLayer(memory: Pick<Scoped, "scope" | "projectId">): MemoryLayer {
  if (memory.scope === "global") return "global";
  if (memory.scope === "project") return "team";
  return memory.projectId ? "mine" : "craft";
}

/** Inside a project what an agent learns is its notes on the project; outside, its craft. */
export const defaultMemoryLayer = (projectId: string | null): MemoryLayer => (projectId ? "mine" : "craft");

/** Where a write of `layer` goes: its scope and project (the run's, or the one the super agent names). */
export function layerTarget(
  layer: MemoryLayer,
  projectId: string | null,
): { scope: Scoped["scope"]; projectId: string | null } {
  if (layer === "global") return { scope: "global", projectId: null };
  if (layer === "craft") return { scope: "agent", projectId: null };
  return { scope: layer === "team" ? "project" : "agent", projectId };
}
