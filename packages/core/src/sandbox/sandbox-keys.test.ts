import { describe, expect, it } from "vitest";
import { conversationWorkspaceKey, mcpWorkspaceKeyFor, projectWorkspaceKey, workspaceOwner } from "./sandbox-keys";

const id = "0b9f6a2e-6c1d-4c47-9a53-2f7d1b8e4c10";
const mcpKey = mcpWorkspaceKeyFor("github-issues", { projectId: id });

describe("workspace keys", () => {
  it("builds keys that fit container and volume names", () => {
    for (const key of [projectWorkspaceKey(id), conversationWorkspaceKey(id), mcpKey]) {
      expect(key).toMatch(/^[a-z0-9-]{1,63}$/);
    }
  });

  it("maps keys back to their owner", () => {
    expect(workspaceOwner(projectWorkspaceKey(id))).toEqual({ kind: "project", id });
    expect(workspaceOwner(conversationWorkspaceKey(id))).toEqual({ kind: "conversation", id });
    expect(workspaceOwner(mcpKey)).toEqual({ kind: "mcp" });
  });

  it("ignores keys Abotica did not create", () => {
    expect(workspaceOwner("probe")).toBeNull();
    expect(workspaceOwner("project-not-a-uuid")).toBeNull();
    expect(workspaceOwner("conversation-")).toBeNull();
    expect(workspaceOwner("mcp-")).toBeNull();
  });
});
