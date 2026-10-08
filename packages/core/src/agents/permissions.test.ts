import { describe, expect, it } from "vitest";
import {
  annotationPermission,
  builtinPermission,
  clampPermission,
  defaultPermissions,
  MCP_ALL_KEY,
  MCP_DEFAULT_PERMISSION,
  mcpServerKey,
  mcpServerPermission,
  mcpToolHint,
  mcpToolKey,
  mcpToolDefault,
  mcpToolPermission,
  sanitizePermissions,
} from "./permissions";
import { TOOL_CATALOG, type ToolInfo } from "./tools/tool-catalog";

// Picked from the catalog by flag so the tests survive tools being added or renamed.
function pick(predicate: (tool: ToolInfo) => boolean): ToolInfo {
  const tool = TOOL_CATALOG.find(predicate);
  if (!tool) throw new Error("no catalog tool matches");
  return tool;
}
const plain = pick((t) => !t.alwaysAsk && !t.orchestratorOnly && !t.defaultPermission);
const alwaysAsk = pick((t) => !!t.alwaysAsk);
const orchestratorOnly = pick((t) => !!t.orchestratorOnly && !t.alwaysAsk && !t.managers);
const managerTool = pick((t) => !!t.orchestratorOnly && !!t.managers);
const askByDefault = pick((t) => t.defaultPermission === "ask" && !t.orchestratorOnly);

const worker = { isOrchestrator: false, isManager: false };
const manager = { isOrchestrator: false, isManager: true };
const orchestrator = { isOrchestrator: true, isManager: false };

describe("clampPermission", () => {
  it("turns allow into ask for always-ask tools only", () => {
    expect(clampPermission(alwaysAsk, "allow")).toBe("ask");
    expect(clampPermission(alwaysAsk, "deny")).toBe("deny");
    expect(clampPermission(plain, "allow")).toBe("allow");
    expect(clampPermission(undefined, "allow")).toBe("allow");
  });
});

describe("builtinPermission", () => {
  it("denies unknown tools and tools missing from the map", () => {
    expect(builtinPermission({ nope: "allow" }, "nope", orchestrator)).toBe("deny");
    expect(builtinPermission({}, plain.name, worker)).toBe("deny");
  });

  it("denies orchestrator-only tools to other agents", () => {
    const permissions = { [orchestratorOnly.name]: "allow" } as const;
    expect(builtinPermission(permissions, orchestratorOnly.name, worker)).toBe("deny");
    expect(builtinPermission(permissions, orchestratorOnly.name, orchestrator)).toBe("allow");
  });

  it("gives manager tools to managers, at their default unless stored otherwise", () => {
    expect(builtinPermission({}, managerTool.name, worker)).toBe("deny");
    expect(builtinPermission({ [managerTool.name]: "allow" }, managerTool.name, worker)).toBe("deny");
    expect(builtinPermission({}, managerTool.name, manager)).toBe(managerTool.defaultPermission ?? "allow");
    expect(builtinPermission({ [managerTool.name]: "deny" }, managerTool.name, manager)).toBe("deny");
    expect(builtinPermission({ [managerTool.name]: "ask" }, managerTool.name, manager)).toBe("ask");
    expect(builtinPermission({ [orchestratorOnly.name]: "allow" }, orchestratorOnly.name, manager)).toBe("deny");
  });

  it("keeps the orchestrator's stored manager tools as they are", () => {
    expect(builtinPermission({}, managerTool.name, orchestrator)).toBe("deny");
    expect(builtinPermission({ [managerTool.name]: "allow" }, managerTool.name, orchestrator)).toBe("allow");
  });

  it("never lets an always-ask tool run silently", () => {
    expect(builtinPermission({ [alwaysAsk.name]: "allow" }, alwaysAsk.name, orchestrator)).toBe("ask");
  });
});

describe("MCP permissions", () => {
  it("builds keys", () => {
    expect(mcpServerKey("github")).toBe("mcp:github");
    expect(mcpToolKey("github", "create_issue")).toBe("mcp:github/create_issue");
  });

  it("falls back tool -> server -> mcp:* -> default", () => {
    expect(mcpToolPermission({}, "github", "x")).toBe(MCP_DEFAULT_PERMISSION);
    expect(mcpToolPermission({ [MCP_ALL_KEY]: "deny" }, "github", "x")).toBe("deny");
    expect(mcpToolPermission({ [MCP_ALL_KEY]: "deny", "mcp:github": "ask" }, "github", "x")).toBe("ask");
    expect(mcpToolPermission({ "mcp:github": "ask", "mcp:github/x": "allow" }, "github", "x")).toBe("allow");
    expect(mcpServerPermission({ "mcp:github/x": "deny" }, "github")).toBe(MCP_DEFAULT_PERMISSION);
  });
});

describe("mcpToolDefault", () => {
  it("is the default from the hints, unless a bundled server sets its own", () => {
    expect(mcpToolDefault({ readOnlyHint: true }, null)).toBe("allow");
    expect(mcpToolDefault({ destructiveHint: true }, null)).toBe("ask");
    expect(mcpToolDefault({ destructiveHint: true }, "context7")).toBe("ask");
    // Playwright declares clicks and typing destructive; browsing would ask at every step.
    expect(mcpToolDefault({ destructiveHint: true }, "playwright")).toBe("allow");
    expect(mcpToolDefault(undefined, "unknown-key")).toBe("ask");
  });
});

describe("MCP tool hints", () => {
  it.each([
    [{ readOnlyHint: true }, "readOnly", "allow"],
    [{ readOnlyHint: true, destructiveHint: true }, "readOnly", "allow"],
    [{ destructiveHint: false }, "nonDestructive", "allow"],
    [{ readOnlyHint: false, destructiveHint: false }, "nonDestructive", "allow"],
    [{ destructiveHint: true }, "destructive", "ask"],
    // Not read-only and no destructiveHint: destructive under the MCP defaults.
    [{ readOnlyHint: false }, "destructive", "ask"],
    [{ readOnlyHint: false, openWorldHint: true }, "destructive", "ask"],
    [{}, "none", "ask"],
    [undefined, "none", "ask"],
    [{ title: "Search", openWorldHint: false }, "none", "ask"],
    [{ readOnlyHint: "true" }, "none", "ask"],
    [{ readOnlyHint: 1, destructiveHint: "false" }, "none", "ask"],
    [{ destructiveHint: null }, "none", "ask"],
  ])("reads %j as %s, starting at %s", (annotations, hint, permission) => {
    expect(mcpToolHint(annotations)).toBe(hint);
    expect(annotationPermission(annotations)).toBe(permission);
  });

  const readOnly = annotationPermission({ readOnlyHint: true });
  const destructive = annotationPermission({ destructiveHint: true });

  it("start a tool without entries at the default from its hints", () => {
    expect(mcpToolPermission({}, "github", "list_issues", readOnly)).toBe("allow");
    expect(mcpToolPermission({}, "github", "delete_repo", destructive)).toBe("ask");
    expect(mcpToolPermission({}, "github", "x", undefined)).toBe("ask");
    expect(mcpServerPermission({}, "github", readOnly)).toBe("allow");
  });

  it("never win over an entry the user set, at any level", () => {
    for (const permission of ["allow", "ask", "deny"] as const) {
      for (const hints of [readOnly, destructive, undefined]) {
        expect(mcpToolPermission({ [MCP_ALL_KEY]: permission }, "github", "x", hints)).toBe(permission);
        expect(mcpToolPermission({ [mcpServerKey("github")]: permission }, "github", "x", hints)).toBe(permission);
        expect(mcpToolPermission({ [mcpToolKey("github", "x")]: permission }, "github", "x", hints)).toBe(permission);
        expect(mcpServerPermission({ [mcpServerKey("github")]: permission }, "github", hints)).toBe(permission);
      }
    }
    // The nearest entry still wins over the farther ones.
    const permissions = {
      [MCP_ALL_KEY]: "deny",
      [mcpServerKey("github")]: "ask",
      [mcpToolKey("github", "x")]: "allow",
    } as const;
    expect(mcpToolPermission(permissions, "github", "x", destructive)).toBe("allow");
    expect(mcpToolPermission(permissions, "github", "y", readOnly)).toBe("ask");
    expect(mcpToolPermission(permissions, "other", "y", readOnly)).toBe("deny");
  });
});

describe("defaultPermissions", () => {
  it("covers only the tools the agent can have", () => {
    expect(Object.keys(defaultPermissions(worker))).not.toContain(orchestratorOnly.name);
    expect(Object.keys(defaultPermissions(worker))).not.toContain(managerTool.name);
    expect(Object.keys(defaultPermissions(manager))).toContain(managerTool.name);
    expect(Object.keys(defaultPermissions(manager))).not.toContain(orchestratorOnly.name);
    expect(Object.keys(defaultPermissions(orchestrator))).toHaveLength(TOOL_CATALOG.length);
  });

  it("starts tools at their default, clamped", () => {
    const permissions = defaultPermissions(orchestrator);
    expect(permissions[plain.name]).toBe("allow");
    expect(permissions[askByDefault.name]).toBe("ask");
    expect(permissions[alwaysAsk.name]).toBe("ask");
  });
});

describe("sanitizePermissions", () => {
  it("drops invalid values, unknown tools and tools the agent cannot have", () => {
    const input = {
      [plain.name]: "allow",
      [askByDefault.name]: "maybe",
      unknown_tool: "allow",
      [orchestratorOnly.name]: "allow",
    };
    expect(sanitizePermissions(input, worker)).toEqual({ [plain.name]: "allow" });
  });

  it("keeps manager tool entries, denials included, for every agent but the orchestrator", () => {
    expect(sanitizePermissions({ [managerTool.name]: "deny" }, worker)).toEqual({ [managerTool.name]: "deny" });
    expect(sanitizePermissions({ [managerTool.name]: "allow" }, manager)).toEqual({ [managerTool.name]: "allow" });
    expect(sanitizePermissions({ [managerTool.name]: "deny" }, orchestrator)).toEqual({});
  });

  it("stores built-in denials as absence and clamps always-ask tools", () => {
    expect(sanitizePermissions({ [plain.name]: "deny", [alwaysAsk.name]: "allow" }, orchestrator)).toEqual({
      [alwaysAsk.name]: "ask",
    });
  });

  it("keeps well-formed MCP keys, including denials", () => {
    const input = {
      "mcp:*": "deny",
      "mcp:my-server": "ask",
      "mcp:my-server/some tool": "allow",
      "mcp:Bad_Slug": "allow",
      "mcp:": "allow",
      "mcp:-x": "allow",
    };
    expect(sanitizePermissions(input, worker)).toEqual({
      "mcp:*": "deny",
      "mcp:my-server": "ask",
      "mcp:my-server/some tool": "allow",
    });
  });
});
