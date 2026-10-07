import { describe, expect, it, vi } from "vitest";
import { GLOBAL_SECRETS, OWNER_SECRETS } from "../platform/vault";
import { mcpWorkspaceKeyFor } from "../sandbox/sandbox-keys";
import { mcpWorkspaceKeys } from "./mcp";

vi.mock("@abotica/db", () => ({ db: {} }));

const projectA = { projectId: "0b9f6a2e-6c1d-4c47-9a53-2f7d1b8e4c10" };
const projectB = { projectId: "5d1c2b3a-1111-4c47-9a53-2f7d1b8e4c10" };

describe("mcpWorkspaceKeyFor", () => {
  it("gives each secret scope of a server its own workspace", () => {
    const keys = [GLOBAL_SECRETS, OWNER_SECRETS, projectA, projectB].map((scope) => mcpWorkspaceKeyFor("tracker", scope));
    expect(new Set(keys).size).toBe(4);
    expect(mcpWorkspaceKeyFor("tracker", projectA)).toBe(keys[2]);
    expect(mcpWorkspaceKeyFor("other", projectA)).not.toBe(keys[2]);
  });

  it("fits container and volume names for the longest slugs, and stays readable", () => {
    const slug = "a-very-long-server-slug-that-uses-all-48-chars-x";
    const key = mcpWorkspaceKeyFor(slug, projectA);
    expect(key).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
    expect(mcpWorkspaceKeyFor("playwright", GLOBAL_SECRETS)).toMatch(/^mcp-playwright-[0-9a-f]{24}$/);
  });

  it("never yields the unscoped key of the older form", () => {
    expect(mcpWorkspaceKeyFor("tracker", GLOBAL_SECRETS)).not.toBe("mcp-tracker");
  });
});

describe("mcpWorkspaceKeys", () => {
  it("lists the workspace of every scope a run or test can open the server in", () => {
    const keys = mcpWorkspaceKeys("tracker", [projectA.projectId, projectB.projectId]);
    expect(keys).toEqual([GLOBAL_SECRETS, OWNER_SECRETS, projectA, projectB].map((s) => mcpWorkspaceKeyFor("tracker", s)));
    expect(mcpWorkspaceKeys("tracker", [])).toHaveLength(2);
  });
});
