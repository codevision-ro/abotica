import {
  AGENT_PERMISSIONS,
  AGENT_TOOLS,
  KIND_TOOLS,
  MANAGER_PERMISSIONS,
  MANAGER_TOOLS,
  ORCHESTRATOR_ONLY_TOOLS,
  ORCHESTRATOR_PERMISSIONS,
} from "@abotica/db/seed-permissions";
import { describe, expect, it } from "vitest";
import { defaultPermissions } from "./permissions";
import { TOOL_CATALOG } from "./tools/tool-catalog";

/** The seeded agents' permissions (packages/db) list tool names by hand; they must match the catalog. */
describe("seed permissions", () => {
  it("cover every tool of the catalog, in the right group", () => {
    const orchestratorOnly = TOOL_CATALOG.filter((t) => t.orchestratorOnly).map((t) => t.name);
    const agentTools = TOOL_CATALOG.filter((t) => !t.orchestratorOnly && !t.kinds).map((t) => t.name);
    expect([...ORCHESTRATOR_ONLY_TOOLS].sort()).toEqual(orchestratorOnly.sort());
    expect([...AGENT_TOOLS].sort()).toEqual(agentTools.sort());
  });

  it("list the tools only some kinds get", () => {
    for (const kind of ["orchestrator", "manager", "specialist"] as const) {
      const forKind = TOOL_CATALOG.filter((t) => t.kinds?.includes(kind)).map((t) => t.name);
      expect([...KIND_TOOLS[kind]].sort(), kind).toEqual(forKind.sort());
    }
  });

  it("mark the tools managers get", () => {
    expect([...MANAGER_TOOLS].sort()).toEqual(
      TOOL_CATALOG.filter((t) => t.managers)
        .map((t) => t.name)
        .sort(),
    );
  });

  it("match what a new agent of each kind starts with", () => {
    expect(AGENT_PERMISSIONS).toEqual(defaultPermissions({ kind: "specialist" }));
    expect(MANAGER_PERMISSIONS).toEqual(defaultPermissions({ kind: "manager" }));
    expect(ORCHESTRATOR_PERMISSIONS).toEqual(defaultPermissions({ kind: "orchestrator" }));
  });
});
