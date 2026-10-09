import { MCP_ALL_KEY, mcpServerKey, mcpToolKey } from "@abotica/core/agents/permissions";
import type { McpToolInfo } from "@abotica/db";
import { describe, expect, it } from "vitest";
import { withAllAllowed, withMcpTool } from "./mcp-permission-values";

const tool = (name: string): McpToolInfo => ({ name, description: "" });
const list = tool("list_issues");
const remove = tool("delete_repo");
const plain = tool("run");
const github = { slug: "github" };

describe("withMcpTool", () => {
  it("stores a tool's choice only when it differs from what the tool would inherit", () => {
    expect(withMcpTool({}, github, list, "allow")).toEqual({});
    expect(withMcpTool({}, github, list, "ask")).toEqual({ [mcpToolKey("github", "list_issues")]: "ask" });
    expect(withMcpTool({}, github, remove, "allow")).toEqual({});
    expect(withMcpTool({}, github, remove, "ask")).toEqual({ [mcpToolKey("github", "delete_repo")]: "ask" });
    expect(withMcpTool({ [mcpToolKey("github", "run")]: "ask" }, github, plain, "allow")).toEqual({});
    // Under a server setting, the setting is what it would inherit.
    const server = { [mcpServerKey("github")]: "deny" } as const;
    expect(withMcpTool(server, github, list, "deny")).toEqual(server);
    expect(withMcpTool(server, github, list, "allow")).toEqual({
      ...server,
      [mcpToolKey("github", "list_issues")]: "allow",
    });
  });
});

describe("withAllAllowed", () => {
  it("allows every built-in tool and drops every MCP entry", () => {
    const perms = {
      memory_save: "deny",
      web_fetch: "ask",
      [MCP_ALL_KEY]: "ask",
      [mcpServerKey("github")]: "deny",
      [mcpToolKey("docs", "search")]: "ask",
    } as const;
    expect(withAllAllowed(perms)).toEqual({ memory_save: "allow", web_fetch: "allow" });
  });
});
