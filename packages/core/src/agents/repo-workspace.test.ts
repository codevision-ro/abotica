import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { ExecOptions, SandboxProcess, Workspace } from "@abotica/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareRepos, repoGitEnv, type WorkspaceRepo } from "./repo-workspace";
import { taskBranch } from "./workspace-paths";

/**
 * prepareRepos against real git: a bare repository on disk plays the remote, and the "sandbox" is
 * a folder where commands run with bash. Only the network policy is not exercised here.
 */

const TASK = "1a2b3c4d-0000-4000-8000-000000000001";
const OTHER_TASK = "5e6f7a8b-0000-4000-8000-000000000002";
const AUTHOR = { name: "Web Developer", email: "web-developer@agents.abotica.invalid" };

let root: string;
let home: string;

/** Commands run in the workspace folder with a clean HOME and no system git configuration. */
function localWorkspace(dir: string): Workspace {
  return {
    key: "test",
    paths: { workspace: dir, bundles: path.join(dir, ".bundles"), home },
    async exec(options: ExecOptions): Promise<SandboxProcess> {
      const child = spawn("bash", ["-c", options.command], {
        cwd: options.cwd ? path.resolve(dir, options.cwd) : dir,
        env: { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...options.env },
        stdio: [options.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
      });
      const exited = new Promise<{ exitCode: number; timedOut: boolean }>((resolve) =>
        child.on("close", (code) => resolve({ exitCode: code ?? 1, timedOut: false })),
      );
      return {
        stdin: child.stdin ? (Writable.toWeb(child.stdin) as WritableStream<Uint8Array>) : null,
        stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
        wait: () => exited,
        kill: async () => void child.kill("SIGKILL"),
      };
    },
  };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...gitIdentity },
    encoding: "utf8",
  }).trim();

const gitIdentity = {
  GIT_AUTHOR_NAME: "Owner",
  GIT_AUTHOR_EMAIL: "owner@example.invalid",
  GIT_COMMITTER_NAME: "Owner",
  GIT_COMMITTER_EMAIL: "owner@example.invalid",
};

/** A bare remote with one commit on main, and a clone of it to change the remote with. */
async function makeRemote(name: string) {
  const remote = path.join(root, `${name}.git`);
  const upstream = path.join(root, `${name}-upstream`);
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  git(root, "init", "--quiet", "--initial-branch=main", upstream);
  git(upstream, "remote", "add", "origin", remote);
  await writeFile(path.join(upstream, "README.md"), "hello\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "--quiet", "-m", "first");
  git(upstream, "push", "--quiet", "-u", "origin", "main");
  const repo: WorkspaceRepo = {
    name,
    provider: "github",
    host: "github.com",
    cloneUrl: `file://${remote}`,
    defaultBranch: "main",
    token: "ghp_test_token_value",
  };
  return { remote, upstream, repo };
}

async function prepare(workspace: Workspace, repos: WorkspaceRepo[], taskId: string | null, finished: string[] = []) {
  const errors: string[] = [];
  await prepareRepos(workspace, {
    repos,
    env: repoGitEnv(repos, AUTHOR),
    taskId,
    finishedTasks: async (ids) => new Set(ids.filter((id) => finished.includes(id))),
    signal: new AbortController().signal,
    onError: (message) => errors.push(message),
  });
  return errors;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "abotica-repos-"));
  home = path.join(root, "home");
  await mkdir(home);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("prepareRepos", () => {
  it("clones a missing repository and fetches it on later runs", async () => {
    const { upstream, repo } = await makeRemote("site");
    const dir = path.join(root, "ws");
    await mkdir(dir);
    const workspace = localWorkspace(dir);

    expect(await prepare(workspace, [repo], null)).toEqual([]);
    const clone = path.join(dir, "repos/site");
    expect(git(clone, "log", "--format=%s")).toBe("first");

    await writeFile(path.join(upstream, "README.md"), "changed\n");
    git(upstream, "commit", "--quiet", "-am", "second");
    git(upstream, "push", "--quiet", "origin", "main");
    expect(await prepare(workspace, [repo], null)).toEqual([]);
    expect(git(clone, "log", "--format=%s", "origin/main")).toBe("second\nfirst");
  });

  it("gives a task its own worktree on its branch, from the default branch", async () => {
    const { repo } = await makeRemote("site");
    const dir = path.join(root, "ws");
    await mkdir(dir);

    expect(await prepare(localWorkspace(dir), [repo], TASK)).toEqual([]);
    const worktree = path.join(dir, "work", TASK, "site");
    expect(git(worktree, "branch", "--show-current")).toBe(taskBranch(TASK));
    expect(git(worktree, "log", "--format=%s")).toBe("first");
    expect(git(path.join(dir, "repos/site"), "branch", "--show-current")).toBe("main");
  });

  it("continues a task branch that is already on the remote", async () => {
    const { upstream, repo } = await makeRemote("site");
    git(upstream, "switch", "--quiet", "-c", taskBranch(TASK));
    await writeFile(path.join(upstream, "page.html"), "<h1>Crumb</h1>\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "--quiet", "-m", "task work");
    git(upstream, "push", "--quiet", "origin", taskBranch(TASK));
    const dir = path.join(root, "ws");
    await mkdir(dir);

    expect(await prepare(localWorkspace(dir), [repo], TASK)).toEqual([]);
    expect(git(path.join(dir, "work", TASK, "site"), "log", "-1", "--format=%s")).toBe("task work");
  });

  it("commits as the agent and pushes with plain git", async () => {
    const { remote, repo } = await makeRemote("site");
    const dir = path.join(root, "ws");
    await mkdir(dir);
    const workspace = localWorkspace(dir);
    await prepare(workspace, [repo], TASK);

    const proc = await workspace.exec({
      command: `cd work/${TASK}/site && echo x > new.txt && git add . && git commit --quiet -m change && git push --quiet -u origin HEAD`,
      env: repoGitEnv([repo], AUTHOR),
      egress: [],
    });
    expect((await proc.wait()).exitCode).toBe(0);
    expect(git(remote, "log", "-1", "--format=%an <%ae>", taskBranch(TASK))).toBe(`${AUTHOR.name} <${AUTHOR.email}>`);
  });

  it("removes the worktrees of finished tasks only when nothing would be lost", async () => {
    const { repo } = await makeRemote("site");
    const dir = path.join(root, "ws");
    await mkdir(dir);
    const workspace = localWorkspace(dir);
    const clean = "a0000000-0000-4000-8000-000000000000";
    const pushed = "b0000000-0000-4000-8000-000000000000";
    const unpushed = "c0000000-0000-4000-8000-000000000000";
    const dirty = "d0000000-0000-4000-8000-000000000000";
    const open = "e0000000-0000-4000-8000-000000000000";
    for (const id of [clean, pushed, unpushed, dirty, open]) expect(await prepare(workspace, [repo], id)).toEqual([]);
    const tree = (id: string) => path.join(dir, "work", id, "site");
    const env = { ...gitIdentity };
    const sh = async (command: string) => {
      const proc = await workspace.exec({ command, env: { ...repoGitEnv([repo], AUTHOR), ...env }, egress: [] });
      const stderr = new Response(proc.stderr).text();
      const exitCode = (await proc.wait()).exitCode;
      expect({ exitCode, stderr: await stderr }).toEqual({ exitCode: 0, stderr: "" });
    };
    await sh(`cd work/${pushed}/site && echo a > a.txt && git add . && git commit -qm a && git push -q -u origin HEAD`);
    await sh(`cd work/${unpushed}/site && echo b > b.txt && git add . && git commit -qm b`);
    await writeFile(path.join(tree(dirty), "draft.txt"), "not committed\n");

    expect(await prepare(workspace, [repo], null, [clean, pushed, unpushed, dirty])).toEqual([]);
    const clone = path.join(dir, "repos/site");
    const branches = git(clone, "branch", "--format=%(refname:short)").split("\n");
    for (const id of [clean, pushed]) {
      expect(() => git(tree(id), "status")).toThrow();
      expect(branches).not.toContain(taskBranch(id));
    }
    for (const id of [unpushed, dirty, open]) {
      expect(git(tree(id), "branch", "--show-current")).toBe(taskBranch(id));
    }
  });

  it("reports a folder in the way instead of touching it", async () => {
    const { repo } = await makeRemote("site");
    const dir = path.join(root, "ws");
    await mkdir(path.join(dir, "repos/site"), { recursive: true });
    await writeFile(path.join(dir, "repos/site/notes.txt"), "mine\n");

    const errors = await prepare(localWorkspace(dir), [repo], OTHER_TASK);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("exists but is not a git repository");
  });
});

describe("repoGitEnv", () => {
  const site: WorkspaceRepo = {
    name: "site",
    provider: "github",
    host: "github.com",
    cloneUrl: "https://github.com/acme/site.git",
    defaultBranch: "main",
    token: "ghp_site_token",
  };
  const api: WorkspaceRepo = {
    ...site,
    name: "api",
    provider: "gitlab",
    host: "gitlab.com",
    cloneUrl: "https://gitlab.com/acme/api.git",
    token: "glpat_api_token",
  };

  /** What git's credential lookup answers for a URL in a workspace with this environment. */
  function credentialFor(url: string, env: Record<string, string>): string {
    try {
      return execFileSync("git", ["credential", "fill"], {
        cwd: root,
        input: `url=${url}\n\n`,
        env: { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...env },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      return "refused";
    }
  }

  it("answers each repository with its own token, with or without .git", () => {
    const env = repoGitEnv([site, api], AUTHOR);
    expect(credentialFor("https://github.com/acme/site.git", env)).toContain("password=ghp_site_token");
    expect(credentialFor("https://github.com/acme/site", env)).toContain("username=x-access-token");
    expect(credentialFor("https://gitlab.com/acme/api.git", env)).toContain("password=glpat_api_token");
    expect(credentialFor("https://gitlab.com/acme/api", env)).toContain("username=oauth2");
  });

  it("gives other repositories nothing, without prompting", () => {
    const env = repoGitEnv([site], AUTHOR);
    expect(credentialFor("https://github.com/acme/other.git", env)).toBe("refused");
    expect(credentialFor("https://github.com/acme/site-fork.git", env)).toBe("refused");
  });

  it("sets the author and no credentials without repositories", () => {
    const env = repoGitEnv([], AUTHOR);
    expect(env).toEqual({
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_COMMITTER_NAME: AUTHOR.name,
      GIT_COMMITTER_EMAIL: AUTHOR.email,
      GIT_TERMINAL_PROMPT: "0",
    });
  });
});
