import type { OfficeInteraction, OfficeState } from "@abotica/core/office";

/** Where an agent was clicked: in a room, or at the super agent's desk / in the lounge (null). */
export type OfficeAgentTarget = { agentId: string; projectId: string | null };

/** What the office page hands the 3D scene (scene/office-scene.tsx, loaded only on desktop). */
export type OfficeSceneProps = {
  state: OfficeState;
  /**
   * Interactions that arrived after the page opened, oldest first; the scene plays each one once
   * (it remembers the ids it played), so the list may keep growing.
   */
  live: OfficeInteraction[];
  /** The interaction picked in the feed: the camera goes to it. */
  focusInteractionId: string | null;
  onSelectAgent: (target: OfficeAgentTarget) => void;
  onSelectRoom: (projectId: string) => void;
};
