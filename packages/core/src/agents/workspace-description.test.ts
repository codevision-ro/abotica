import { describe, expect, it } from "vitest";
import { workspaceDescription, type WorkspaceDescriptionInput } from "./workspace-description";

const base: WorkspaceDescriptionInput = {
  paths: { workspace: "/workspace", bundles: "/opt/abotica/bundles", home: "/workspace/.home" },
  scope: "conversation",
  network: { mode: "packages", domains: [] },
  packages: { python: [], node: [] },
  skills: [],
  commandTimeoutSec: 300,
  idle: { pauseIdleMinutes: 15, stopIdleHours: 6, workspaceRetentionDays: 30 },
  repos: [],
  taskId: null,
  root: false,
};

const repo = {
  name: "site",
  provider: "github" as const,
  webUrl: "https://github.com/acme/site",
  defaultBranch: "main",
};

describe("workspaceDescription", () => {
  it("names the paths, the timeout and how to share files", () => {
    const text = workspaceDescription(base);
    expect(text).toContain("Working directory: /workspace.");
    expect(text).toContain("/workspace/inputs");
    expect(text).toContain("other agents");
    expect(text).toContain("HOME is /workspace/.home");
    expect(text).toContain("300 seconds");
    expect(text).toContain("file_share");
    expect(text).not.toContain("skills are available");
    expect(text).not.toContain("/workspace/knowledge");
  });

  it("describes each network mode in words", () => {
    const of = (network: WorkspaceDescriptionInput["network"]) => workspaceDescription({ ...base, network });
    expect(of({ mode: "off", domains: ["ignored.com"] })).toContain("Network: none");
    expect(of({ mode: "packages", domains: [] })).toContain("only the package registries");
    expect(of({ mode: "packages", domains: [] })).toContain("HTTP 403");
    const custom = of({ mode: "custom", domains: ["api.example.com", "*.github.com"] });
    expect(custom).toContain("api.example.com, *.github.com");
    expect(custom).toContain("HTTP 403");
    expect(of({ mode: "full", domains: [] })).toContain("any public internet host");
  });

  it("lists skills, preinstalled packages and the project scope", () => {
    const text = workspaceDescription({
      ...base,
      scope: "project",
      skills: ["pdf", "xlsx"],
      packages: { python: ["pandas==2.2.3"], node: ["sharp"] },
    });
    expect(text).toContain("/opt/abotica/bundles/<skill>: pdf, xlsx");
    expect(text).toContain("pandas==2.2.3");
    expect(text).toContain("sharp");
    expect(text).toContain("every conversation of this project");
    expect(text).toContain("/workspace/knowledge holds the project's knowledge files, read-only");
  });

  it("says where the full text of cut tool output is", () => {
    const text = workspaceDescription(base);
    expect(text).toContain("cut in the middle");
    expect(text).toContain("/workspace/tool-output for 7 days");
  });

  it("explains the database servers and background processes", () => {
    const text = workspaceDescription(base);
    expect(text).toContain("`services start mysql`");
    expect(text).toContain("nohup");
  });

  it("states the idle pause, stop and retention from the settings", () => {
    const text = workspaceDescription(base);
    expect(text).toContain("After 15 minutes without use");
    expect(text).toContain("after 6 hours they stop");
    expect(text).toContain("unused for 30 days: then it is deleted");
    const custom = workspaceDescription({
      ...base,
      idle: { pauseIdleMinutes: 1, stopIdleHours: 48, workspaceRetentionDays: 1 },
    });
    expect(custom).toContain("After 1 minute without use");
    expect(custom).toContain("after 48 hours they stop");
    expect(custom).toContain("unused for 1 day:");
    // A project's workspace lives as long as the project.
    expect(workspaceDescription({ ...base, scope: "project" })).not.toContain("then it is deleted");
  });

  it("mentions root commands only to agents that may run them", () => {
    expect(workspaceDescription(base)).not.toContain("shell_run_root");
    const text = workspaceDescription({ ...base, root: true });
    expect(text).toContain("shell_run_root runs a command as root");
    expect(text).toContain("apt-get install");
  });

  it("tells the agent how to see what it builds", () => {
    const text = workspaceDescription({
      ...base,
      paths: { ...base.paths, mcpOutput: "/opt/abotica/mcp/out" },
    });
    expect(text).toContain("file_read also shows you images");
    expect(text).toContain("http://localhost:8000");
    expect(text).toContain("python3 -m http.server 8000 --directory site");
    expect(text).toContain("file:// is not available");
    expect(text).toContain("saved in /opt/abotica/mcp/out/playwright, read-only for you");
    expect(text).toContain("to upload one to a site, use a browser script of your own");
    expect(text).toContain("$CHROMIUM_PATH");
    expect(text).toContain("executablePath: process.env.CHROMIUM_PATH");
    expect(text).toContain('executable_path=os.environ["CHROMIUM_PATH"]');
    expect(text).toContain("abotica-proxy-run node");
    expect(text).toContain("Do not run `playwright install`");
    // Without an MCP output folder the browser keeps its files elsewhere: no path is named.
    expect(workspaceDescription(base)).not.toContain("/playwright");
  });

  it("does not tell the agent to stop at blocked hosts on the full network", () => {
    const text = workspaceDescription({ ...base, network: { mode: "full", domains: [] } });
    expect(text).not.toContain("tell the user which host");
    expect(text).not.toContain("HTTP 403");
    expect(text).toContain("ssh, scp and rsync");
  });

  it("names every registry the packages mode allows", () => {
    const text = workspaceDescription(base);
    for (const name of ["PyPI", "npm", "Packagist", "Debian"]) expect(text).toContain(name);
  });

  it("says nothing about git without repositories", () => {
    expect(workspaceDescription(base)).not.toContain("repos/");
  });

  it("lists the repositories and how to push outside a task", () => {
    const text = workspaceDescription({ ...base, scope: "project", repos: [repo] });
    expect(text).toContain("repos/site: https://github.com/acme/site (GitHub, default branch main)");
    expect(text).toContain("Never push to a default branch");
    expect(text).toContain("repo_open_pr");
    expect(text).toContain("git switch -c");
    expect(text).not.toContain("worktree");
    // The token never enters the workspace, so the agent is not told it is there.
    expect(text).toContain("no token in your environment");
  });

  it("points a task at its worktrees and branch", () => {
    const taskId = "1a2b3c4d-0000-4000-8000-000000000000";
    const text = workspaceDescription({
      ...base,
      scope: "project",
      repos: [repo, { ...repo, name: "api", provider: "gitlab", webUrl: "https://gitlab.com/acme/api" }],
      taskId,
    });
    expect(text).toContain(`work/${taskId}/site, work/${taskId}/api`);
    expect(text).toContain("branch abotica/task-1a2b3c4d");
    expect(text).toContain("pull (merge) request");
  });

  it("uses no em or en dashes", () => {
    const full = { ...base, skills: ["a"], packages: { python: ["x"], node: ["y"] }, repos: [repo], root: true };
    expect(workspaceDescription(full)).not.toMatch(/[\u2013\u2014]/);
    expect(workspaceDescription({ ...full, taskId: "1a2b3c4d-0000-4000-8000-000000000000" })).not.toMatch(/[\u2013\u2014]/);
  });
});
