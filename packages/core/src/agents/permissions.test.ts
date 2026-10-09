import { describe, expect, it } from "vitest";
import {
  builtinPermission,
  defaultPermissions,
  MCP_ALL_KEY,
  MCP_DEFAULT_PERMISSION,
  mcpServerKey,
  mcpServerPermission,
  mcpToolHint,
  mcpToolKey,
  mcpToolDefault,
  mcpRunPermission,
  mcpToolPermission,
  sanitizePermissions,
  toolAvailableTo,
} from "./permissions";
import { TOOL_CATALOG, type ToolInfo } from "./tools/tool-catalog";

// Picked from the catalog by flag so the tests survive tools being added or renamed.
function pick(predicate: (tool: ToolInfo) => boolean): ToolInfo {
  const tool = TOOL_CATALOG.find(predicate);
  if (!tool) throw new Error("no catalog tool matches");
  return tool;
}
const plain = pick((t) => !t.orchestratorOnly && !t.kinds);
const otherPlain = pick((t) => !t.orchestratorOnly && !t.kinds && t.name !== plain.name);
const specialistOnly = pick((t) => t.kinds?.length === 1 && t.kinds[0] === "specialist");
const workerTool = pick((t) => t.kinds?.includes("manager") === true && t.kinds.includes("specialist"));
const orchestratorOnly = pick((t) => !!t.orchestratorOnly && !t.managers);
const managerTool = pick((t) => !!t.orchestratorOnly && !!t.managers);

const specialist = { kind: "specialist" } as const;
const manager = { kind: "manager" } as const;
const orchestrator = { kind: "orchestrator" } as const;

describe("builtinPermission", () => {
  it("allows a tool the agent can have and has no entry for, and keeps the entry it has", () => {
    expect(builtinPermission({}, plain.name, specialist)).toBe("allow");
    expect(builtinPermission({ [plain.name]: "deny" }, plain.name, specialist)).toBe("deny");
    expect(builtinPermission({ [plain.name]: "ask" }, plain.name, specialist)).toBe("ask");
    expect(builtinPermission({}, orchestratorOnly.name, orchestrator)).toBe("allow");
  });

  it("denies unknown tools", () => {
    expect(builtinPermission({ nope: "allow" }, "nope", orchestrator)).toBe("deny");
  });

  it("denies orchestrator-only tools to other agents", () => {
    const permissions = { [orchestratorOnly.name]: "allow" } as const;
    expect(builtinPermission(permissions, orchestratorOnly.name, specialist)).toBe("deny");
    expect(builtinPermission({}, orchestratorOnly.name, specialist)).toBe("deny");
    expect(builtinPermission(permissions, orchestratorOnly.name, orchestrator)).toBe("allow");
  });

  it("gives manager tools to managers and the super agent only", () => {
    expect(builtinPermission({}, managerTool.name, specialist)).toBe("deny");
    expect(builtinPermission({ [managerTool.name]: "allow" }, managerTool.name, specialist)).toBe("deny");
    expect(builtinPermission({}, managerTool.name, manager)).toBe("allow");
    expect(builtinPermission({ [managerTool.name]: "deny" }, managerTool.name, manager)).toBe("deny");
    expect(builtinPermission({ [managerTool.name]: "ask" }, managerTool.name, manager)).toBe("ask");
    expect(builtinPermission({ [orchestratorOnly.name]: "allow" }, orchestratorOnly.name, manager)).toBe("deny");
    expect(builtinPermission({}, managerTool.name, orchestrator)).toBe("allow");
    expect(builtinPermission({ [managerTool.name]: "deny" }, managerTool.name, orchestrator)).toBe("deny");
  });

  it("gives a tool for some kinds only to agents of those kinds", () => {
    expect(builtinPermission({}, specialistOnly.name, specialist)).toBe("allow");
    expect(builtinPermission({ [specialistOnly.name]: "allow" }, specialistOnly.name, manager)).toBe("deny");
    expect(builtinPermission({}, specialistOnly.name, orchestrator)).toBe("deny");
    expect(builtinPermission({}, workerTool.name, manager)).toBe("allow");
    expect(builtinPermission({}, workerTool.name, orchestrator)).toBe("deny");
  });
});

describe("toolAvailableTo", () => {
  it("matches what builtinPermission denies whatever is stored", () => {
    for (const subject of [specialist, manager, orchestrator]) {
      for (const tool of TOOL_CATALOG) {
        const denied = builtinPermission({ [tool.name]: "allow" }, tool.name, subject) === "deny";
        expect(toolAvailableTo(tool, subject), `${tool.name} for ${subject.kind}`).toBe(!denied);
      }
    }
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
  it("allows every tool whatever its hints, unless a bundled server sets its own", () => {
    expect(MCP_DEFAULT_PERMISSION).toBe("allow");
    for (const annotations of [{ readOnlyHint: true }, { destructiveHint: true }, { readOnlyHint: false }, {}, undefined]) {
      expect(mcpToolDefault(annotations, null)).toBe("allow");
      expect(mcpToolDefault(annotations, "context7")).toBe("allow");
      expect(mcpToolDefault(annotations, "unknown-key")).toBe("allow");
    }
    expect(mcpToolDefault({ destructiveHint: true }, "playwright")).toBe("allow");
  });
});

describe("MCP tool hints", () => {
  it.each([
    [{ readOnlyHint: true }, "readOnly"],
    [{ readOnlyHint: true, destructiveHint: true }, "readOnly"],
    [{ destructiveHint: false }, "nonDestructive"],
    [{ readOnlyHint: false, destructiveHint: false }, "nonDestructive"],
    [{ destructiveHint: true }, "destructive"],
    // Not read-only and no destructiveHint: destructive under the MCP defaults.
    [{ readOnlyHint: false }, "destructive"],
    [{ readOnlyHint: false, openWorldHint: true }, "destructive"],
    [{}, "none"],
    [undefined, "none"],
    [{ title: "Search", openWorldHint: false }, "none"],
    [{ readOnlyHint: "true" }, "none"],
    [{ readOnlyHint: 1, destructiveHint: "false" }, "none"],
    [{ destructiveHint: null }, "none"],
  ])("reads %j as %s", (annotations, hint) => {
    expect(mcpToolHint(annotations)).toBe(hint);
  });

  it("never win over an entry the user set, at any level", () => {
    for (const permission of ["allow", "ask", "deny"] as const) {
      for (const toolDefault of ["allow", "ask", undefined] as const) {
        expect(mcpToolPermission({ [MCP_ALL_KEY]: permission }, "github", "x", toolDefault)).toBe(permission);
        expect(mcpToolPermission({ [mcpServerKey("github")]: permission }, "github", "x", toolDefault)).toBe(permission);
        expect(mcpToolPermission({ [mcpToolKey("github", "x")]: permission }, "github", "x", toolDefault)).toBe(permission);
        expect(mcpServerPermission({ [mcpServerKey("github")]: permission }, "github", toolDefault)).toBe(permission);
      }
    }
    // The nearest entry still wins over the farther ones.
    const permissions = {
      [MCP_ALL_KEY]: "deny",
      [mcpServerKey("github")]: "ask",
      [mcpToolKey("github", "x")]: "allow",
    } as const;
    expect(mcpToolPermission(permissions, "github", "x")).toBe("allow");
    expect(mcpToolPermission(permissions, "github", "y")).toBe("ask");
    expect(mcpToolPermission(permissions, "other", "y")).toBe("deny");
  });
});

describe("defaultPermissions", () => {
  it("covers only the tools the agent can have", () => {
    expect(Object.keys(defaultPermissions(specialist))).not.toContain(orchestratorOnly.name);
    expect(Object.keys(defaultPermissions(specialist))).not.toContain(managerTool.name);
    expect(Object.keys(defaultPermissions(manager))).toContain(managerTool.name);
    expect(Object.keys(defaultPermissions(manager))).not.toContain(orchestratorOnly.name);
    expect(Object.keys(defaultPermissions(orchestrator))).toHaveLength(
      TOOL_CATALOG.filter((t) => !t.kinds || t.kinds.includes("orchestrator")).length,
    );
  });

  it("allows every tool", () => {
    for (const subject of [specialist, manager, orchestrator]) {
      expect(new Set(Object.values(defaultPermissions(subject)))).toEqual(new Set(["allow"]));
    }
  });
});

describe("sanitizePermissions", () => {
  it("drops invalid values, unknown tools and tools the agent cannot have", () => {
    const input = {
      [plain.name]: "allow",
      [otherPlain.name]: "maybe",
      [managerTool.name]: "allow",
      unknown_tool: "allow",
      [orchestratorOnly.name]: "allow",
    };
    expect(sanitizePermissions(input, specialist)).toEqual({ [plain.name]: "allow" });
  });

  it("keeps denials, and drops the manager tool entries of agents that cannot have them", () => {
    expect(sanitizePermissions({ [plain.name]: "deny" }, specialist)).toEqual({ [plain.name]: "deny" });
    expect(sanitizePermissions({ [managerTool.name]: "deny" }, manager)).toEqual({ [managerTool.name]: "deny" });
    expect(sanitizePermissions({ [managerTool.name]: "allow" }, manager)).toEqual({ [managerTool.name]: "allow" });
    expect(sanitizePermissions({ [managerTool.name]: "allow" }, specialist)).toEqual({});
    expect(sanitizePermissions({ [managerTool.name]: "deny" }, orchestrator)).toEqual({ [managerTool.name]: "deny" });
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
    expect(sanitizePermissions(input, specialist)).toEqual({
      "mcp:*": "deny",
      "mcp:my-server": "ask",
      "mcp:my-server/some tool": "allow",
    });
  });
});

describe("mcpRunPermission", () => {
  const source = (tool: string) => ({ serverSlug: "site", tool, defaultPermission: "allow" }) as const;

  it("gives every tool of a server, its entries winning over the default", () => {
    expect(mcpRunPermission({}, source("update"))).toBe("allow");
    expect(mcpRunPermission({ "mcp:site": "ask" }, source("update"))).toBe("ask");
    expect(mcpRunPermission({ "mcp:site/update": "deny" }, source("update"))).toBe("deny");
  });
});
