import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand, type Workspace } from "@abotica/sandbox";
import { routeUrl } from "@abotica/sandbox/routes";
import { type EgressProxy, proxiedWorkspace, startEgressProxy, testCertificate } from "@abotica/sandbox/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prepareRepos, type RepoGitAccess, repoGitAccess, type WorkspaceRepo } from "./repo-workspace";
import { type GitServer, startGitServer } from "./test-git-server";
import { bashWorkspace } from "./test-workspace";
import { taskBranch } from "./workspace-paths";

/**
 * prepareRepos against real git: a bare repository on disk plays the remote, and the "sandbox" is
 * a folder where commands run with bash. Over file:// first, for the clones and worktrees; then over
 * HTTPS through the real egress proxy and its credential routes, as in a workspace.
 */

const TASK = "1a2b3c4d-0000-4000-8000-000000000001";
const OTHER_TASK = "5e6f7a8b-0000-4000-8000-000000000002";
const AUTHOR = { name: "Web Developer", email: "web-developer@agents.abotica.invalid" };

let root: string;
let home: string;

/** Commands run in the workspace folder with a clean HOME and no system git configuration. */
const localWorkspace = (dir: string) => bashWorkspace(dir, { HOME: home, GIT_CONFIG_NOSYSTEM: "1" });

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

/** Over file:// git needs no credentials: only the author. */
const localGit = () => repoGitAccess([], AUTHOR);

async function prepare(
  workspace: Workspace,
  repos: WorkspaceRepo[],
  taskId: string | null,
  finished: string[] = [],
  access: RepoGitAccess = localGit(),
) {
  const errors: string[] = [];
  await prepareRepos(workspace, {
    repos,
    git: access,
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
      env: localGit().env,
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
      const proc = await workspace.exec({ command, env: { ...localGit().env, ...env }, egress: [] });
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

describe("repoGitAccess", () => {
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

  /** The URL git uses for a remote URL in a workspace with this environment. */
  const gitUrl = (url: string, env: Record<string, string>) =>
    execFileSync("git", ["ls-remote", "--get-url", url], {
      cwd: root,
      env: { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...env },
      encoding: "utf8",
    }).trim();

  it("sends each repository, with or without .git, through its own route", () => {
    const { env } = repoGitAccess([site, api], AUTHOR);
    expect(gitUrl("https://github.com/acme/site.git", env)).toBe(routeUrl("git-site"));
    expect(gitUrl("https://github.com/acme/site", env)).toBe(routeUrl("git-site"));
    expect(gitUrl("https://gitlab.com/acme/api.git", env)).toBe(routeUrl("git-api"));
    expect(gitUrl("https://github.com/acme/other.git", env)).toBe("https://github.com/acme/other.git");
  });

  it("signs in on the route with each repository's token, which the environment never holds", () => {
    const { env, routes } = repoGitAccess([site, api], AUTHOR);
    const basic = (user: string, token: string) => `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
    expect(routes).toEqual([
      {
        id: "git-site",
        upstream: site.cloneUrl,
        headers: { Authorization: basic("x-access-token", "ghp_site_token") },
      },
      { id: "git-api", upstream: api.cloneUrl, headers: { Authorization: basic("oauth2", "glpat_api_token") } },
    ]);
    expect(JSON.stringify(env)).not.toMatch(/ghp_site_token|glpat_api_token|Basic /);
  });

  it("sets the author and no routes without repositories", () => {
    expect(repoGitAccess([], AUTHOR)).toEqual({
      env: {
        GIT_AUTHOR_NAME: AUTHOR.name,
        GIT_AUTHOR_EMAIL: AUTHOR.email,
        GIT_COMMITTER_NAME: AUTHOR.name,
        GIT_COMMITTER_EMAIL: AUTHOR.email,
        GIT_TERMINAL_PROMPT: "0",
      },
      routes: [],
    });
  });
});

describe("git through the egress proxy", () => {
  const TOKEN = "ghp_route_token_0123456789abcdefghij";
  const certificate = testCertificate();
  let remotes: string;
  let server: GitServer;
  let proxy: EgressProxy;

  /** A repository served at `/git/<name>.git` of the test server. */
  const served = (name: string): WorkspaceRepo => ({
    name,
    provider: "github",
    host: `localhost:${server.port}`,
    cloneUrl: `https://localhost:${server.port}/git/${name}.git`,
    defaultBranch: "main",
    token: TOKEN,
  });

  beforeAll(async () => {
    remotes = mkdtempSync(path.join(tmpdir(), "abotica-remotes-"));
    const env = { PATH: process.env.PATH!, GIT_CONFIG_NOSYSTEM: "1", HOME: remotes, ...gitIdentity };
    const sh = (command: string) => execFileSync("bash", ["-c", command], { cwd: remotes, env, stdio: "ignore" });
    sh(
      "git init --quiet --initial-branch=main seed && cd seed && echo hello > README.md && git add . && git commit -qm first",
    );
    for (const name of ["site", "docs"]) {
      sh(`git clone --quiet --bare seed ${name}.git && git -C ${name}.git config http.receivepack true`);
    }
    server = await startGitServer({
      root: remotes,
      tls: certificate,
      authorization: `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`,
      redirects: {
        // Moved below the repository's own address, which its route covers.
        "/git/docs.git/info/refs": "/git/docs.git/moved/info/refs",
        // Moved to another repository: outside the route.
        "/git/old.git/": "/git/site.git/",
      },
      aliases: { "/git/docs.git/moved/": "/git/docs.git/" },
    });
    proxy = await startEgressProxy({ host: "127.0.0.1", port: 0, unsafeAllowLoopback: true, upstreamCa: certificate.cert });
  });

  afterAll(async () => {
    await proxy.close();
    await server.close();
    rmSync(remotes, { recursive: true, force: true });
  });

  /** A workspace whose commands reach the network only through the proxy, as in the sandbox. */
  async function proxied() {
    const dir = path.join(root, "ws");
    await mkdir(dir);
    return proxiedWorkspace(localWorkspace(dir), proxy);
  }

  const sh = async (workspace: Workspace, access: RepoGitAccess, command: string) =>
    runCommand(workspace, { command, env: access.env, routes: access.routes, egress: [] });

  it("clones, gives the task its worktree and pushes with no token in any command's environment", async () => {
    const repo = served("site");
    const access = repoGitAccess([repo], AUTHOR);
    const workspace = await proxied();
    expect(await prepare(workspace, [repo], TASK, [], access)).toEqual([]);

    const environment = await sh(workspace, access, "env");
    expect(environment.stdout).not.toContain(TOKEN);
    expect(environment.stdout).not.toMatch(/token/i);

    // Over 1 MiB, so git streams the pack in chunks.
    const pushed = await sh(
      workspace,
      access,
      `cd work/${TASK}/site && head -c 3000000 /dev/urandom > blob.bin && git add . && git commit -qm change && git push --quiet -u origin HEAD`,
    );
    expect(pushed).toMatchObject({ exitCode: 0, stderr: "" });
    expect(git(path.join(remotes, "site.git"), "log", "-1", "--format=%an", taskBranch(TASK))).toBe(AUTHOR.name);

    const fetched = await sh(workspace, access, "git -C repos/site fetch --quiet origin && git -C repos/site branch -r");
    expect(fetched.stdout).toContain(`origin/${taskBranch(TASK)}`);
    expect(server.requests.every((r) => r.authorized)).toBe(true);
  });

  it("fetches shallow clones", async () => {
    const access = repoGitAccess([served("site")], AUTHOR);
    const workspace = await proxied();
    const result = await sh(
      workspace,
      access,
      `git clone --quiet --depth 1 ${served("site").cloneUrl} shallow && git -C shallow fetch --quiet --depth 1 origin main && git -C shallow rev-parse --is-shallow-repository`,
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "true\n" });
  });

  it("follows a redirect below the repository's address through the route", async () => {
    const access = repoGitAccess([served("docs")], AUTHOR);
    const workspace = await proxied();
    const result = await sh(
      workspace,
      access,
      `git clone --quiet ${served("docs").cloneUrl} docs && git -C docs log -1 --format=%s`,
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "first\n" });
    expect(server.requests.some((r) => r.url.startsWith("/git/docs.git/moved/") && r.authorized)).toBe(true);
  });

  it("never carries the token along a redirect elsewhere", async () => {
    const before = server.requests.length;
    const access = repoGitAccess([served("old")], AUTHOR);
    const workspace = await proxied();
    const result = await sh(workspace, access, `git clone --quiet ${served("old").cloneUrl} old`);
    expect(result.exitCode).not.toBe(0);
    // The redirect itself came through the route; following it is a direct connection, which the
    // command's network policy refuses before anything reaches the server.
    expect(server.requests.slice(before).map((r) => r.url)).toEqual(["/git/old.git/info/refs?service=git-upload-pack"]);
    expect(result.stderr).not.toContain(TOKEN);
  });
});
