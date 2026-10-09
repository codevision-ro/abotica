import type { Harness } from "../e2e-company";

/** S00: the harness alone. The company is set up and torn down; nothing runs. */
export default async function smoke(h: Harness): Promise<void> {
  h.check(h.manager.kind === "manager" && h.project.managerAgentId === h.manager.id, "the project has its manager");
  h.check(
    h.specialists.every((s) => s.kind === "specialist" && s.provider === h.model.provider && s.model === h.model.model),
    "both specialists are on the test model",
  );
  const run = await h.delegatorRun();
  h.check(run.status === "succeeded" && run.agentId === h.manager.id, "a delegator run stands in for the manager");
}
