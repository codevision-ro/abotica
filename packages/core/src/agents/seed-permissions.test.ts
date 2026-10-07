import { AGENT_TOOLS, ASK_TOOLS, MANAGER_TOOLS, ORCHESTRATOR_ONLY_TOOLS } from "@abotica/db/seed-permissions";
import { describe, expect, it } from "vitest";
import { TOOL_CATALOG } from "./tools/tool-catalog";

/** The seeded agents' permissions (packages/db) list tool names by hand; they must match the catalog. */
describe("seed permissions", () => {
  it("cover every tool of the catalog, in the right group", () => {
    const orchestratorOnly = TOOL_CATALOG.filter((t) => t.orchestratorOnly).map((t) => t.name);
    const agentTools = TOOL_CATALOG.filter((t) => !t.orchestratorOnly).map((t) => t.name);
    expect([...ORCHESTRATOR_ONLY_TOOLS].sort()).toEqual(orchestratorOnly.sort());
    expect([...AGENT_TOOLS].sort()).toEqual(agentTools.sort());
  });

  it("mark the tools that ask and the ones managers get", () => {
    const asking = TOOL_CATALOG.filter((t) => t.alwaysAsk || t.defaultPermission === "ask").map((t) => t.name);
    expect([...ASK_TOOLS].sort()).toEqual(asking.sort());
    expect([...MANAGER_TOOLS].sort()).toEqual(
      TOOL_CATALOG.filter((t) => t.managers)
        .map((t) => t.name)
        .sort(),
    );
  });
});
