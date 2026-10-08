import { MCP_ALL_KEY, MCP_DEFAULT_PERMISSION, mcpServerKey, mcpToolKey } from "@abotica/core/agents/permissions";
import type { McpToolInfo } from "@abotica/db";
import { describe, expect, it } from "vitest";
import { mcpDefaultValue, mcpServerValue, withMcpDefault, withMcpTool } from "./mcp-permission-values";

const tool = (name: string, annotations?: Record<string, unknown>): McpToolInfo => ({
  name,
  description: "",
  ...(annotations && { annotations }),
});
const list = tool("list_issues", { readOnlyHint: true });
const remove = tool("delete_repo", { destructiveHint: true });
const plain = tool("run");
const github = { slug: "github", builtin: null, tools: [list, remove, plain] };
const docs = { slug: "docs", builtin: null, tools: [tool("search", { readOnlyHint: true })] };

describe("mcpServerValue", () => {
  it("shows the default from the hints, mixed when the tools' hints differ", () => {
    expect(mcpServerValue({}, docs)).toBe("allow");
    expect(mcpServerValue({}, { slug: "github", builtin: null, tools: [remove, plain] })).toBe("ask");
    expect(mcpServerValue({}, github)).toBe("mixed");
  });

  it("shows what a bundled server sets instead of its tools' hints", () => {
    const playwright = {
      slug: "playwright",
      builtin: "playwright",
      tools: [tool("browser_click", { destructiveHint: true })],
    };
    expect(mcpServerValue({}, playwright)).toBe("allow");
    expect(mcpDefaultValue({}, [playwright, docs])).toBe("allow");
    expect(mcpServerValue({ [MCP_ALL_KEY]: "ask" }, playwright)).toBe("ask");
  });

  it("shows what the user set for the server or for every server", () => {
    expect(mcpServerValue({ [MCP_ALL_KEY]: "deny" }, github)).toBe("deny");
    expect(mcpServerValue({ [MCP_ALL_KEY]: "deny", [mcpServerKey("github")]: "allow" }, github)).toBe("allow");
    // A tool's own entry is not the server's.
    expect(mcpServerValue({ [mcpToolKey("docs", "search")]: "deny" }, docs)).toBe("allow");
  });

  it("shows the default of an unknown tool while the server's tools are not loaded", () => {
    expect(mcpServerValue({}, { slug: "github", builtin: null, tools: null })).toBe(MCP_DEFAULT_PERMISSION);
    expect(mcpServerValue({ [mcpServerKey("github")]: "deny" }, { slug: "github", builtin: null, tools: [] })).toBe("deny");
  });
});

describe("mcpDefaultValue", () => {
  it("shows its entry when set", () => {
    expect(mcpDefaultValue({ [MCP_ALL_KEY]: "allow" }, [github])).toBe("allow");
  });

  it("unset, shows what the hints give the servers without their own setting", () => {
    expect(mcpDefaultValue({}, [docs])).toBe("allow");
    expect(mcpDefaultValue({}, [docs, github])).toBe("mixed");
    expect(mcpDefaultValue({ [mcpServerKey("github")]: "deny" }, [docs, github])).toBe("allow");
    expect(mcpDefaultValue({}, [])).toBe("mixed");
  });
});

describe("withMcpTool", () => {
  it("stores a tool's choice only when it differs from what the tool would inherit", () => {
    expect(withMcpTool({}, github, list, "allow")).toEqual({});
    expect(withMcpTool({}, github, list, "ask")).toEqual({ [mcpToolKey("github", "list_issues")]: "ask" });
    expect(withMcpTool({}, github, remove, "allow")).toEqual({ [mcpToolKey("github", "delete_repo")]: "allow" });
    expect(withMcpTool({ [mcpToolKey("github", "run")]: "allow" }, github, plain, "ask")).toEqual({});
    // Under a server setting, the setting is what it would inherit.
    const server = { [mcpServerKey("github")]: "deny" } as const;
    expect(withMcpTool(server, github, list, "deny")).toEqual(server);
    expect(withMcpTool(server, github, list, "allow")).toEqual({
      ...server,
      [mcpToolKey("github", "list_issues")]: "allow",
    });
  });
});

describe("withMcpDefault", () => {
  it("sets mcp:* and removes it again, leaving every other entry", () => {
    const perms = { [mcpServerKey("github")]: "ask" } as const;
    const set = withMcpDefault(perms, "allow");
    expect(set).toEqual({ ...perms, [MCP_ALL_KEY]: "allow" });
    expect(withMcpDefault(set, null)).toEqual(perms);
  });
});
