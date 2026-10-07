/**
 * Which memory a run reads and changes. Pure: memory.ts builds the same rule as SQL, the memory
 * tools apply it to single entries.
 */

type Scoped = { scope: "global" | "project" | "agent"; agentId: string | null; projectId: string | null };

/** The run asking: its agent and the one project it works in (null outside projects). */
export type MemoryReader = { agentId: string; projectId: string | null };

/**
 * Global memory, the agent's own, and only the project of the run: an agent on several projects
 * never reads another project's memory in this one. Project memory is shared by the team, whoever wrote it.
 */
export function memoryVisibleTo(memory: Scoped, reader: MemoryReader): boolean {
  if (memory.scope === "global") return true;
  if (memory.scope === "agent") return memory.agentId === reader.agentId;
  return reader.projectId !== null && memory.projectId === reader.projectId;
}

/**
 * Agents change what they could have written: their own memory and the memory of the run's project.
 * Global memory holds the user's facts and preferences, so only the orchestrator changes it.
 */
export function memoryEditableBy(memory: Scoped, editor: MemoryReader & { isOrchestrator: boolean }): boolean {
  if (memory.scope === "global") return editor.isOrchestrator;
  return memoryVisibleTo(memory, editor);
}

/** Inside a project what an agent learns is the project's, authored by it; outside, it is its own. */
export const defaultMemoryScope = (projectId: string | null): "project" | "agent" => (projectId ? "project" : "agent");
