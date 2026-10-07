import { describe, expect, it } from "vitest";
import { HELPER_ENV, helperExecOptions, mcpExecOptions, mcpProcessEnv, processExecOptions } from "./exec";

describe("helperExecOptions", () => {
  it("pins PATH and HOME and runs from /", () => {
    const options = helperExecOptions({ cmd: ["/bin/sh", "-c", "true"], user: "0:0", stdin: true });
    expect(options.Env).toEqual(HELPER_ENV);
    expect(options.Env).toContain("PATH=/usr/sbin:/usr/bin:/sbin:/bin");
    expect(options.Env?.some((entry) => entry.startsWith("HOME=/workspace"))).toBe(false);
    expect(options.WorkingDir).toBe("/");
    expect(options.User).toBe("0:0");
    expect(options.AttachStdin).toBe(true);
  });

  it.each([["sh"], ["tar"], ["./x"], [""]])("refuses the relative command %j", (cmd) => {
    expect(() => helperExecOptions({ cmd: [cmd, "-c", "true"], user: "0:0", stdin: false })).toThrow(/absolute path/);
  });
});

describe("processExecOptions", () => {
  it("wraps the command with absolute binaries as the sandbox user", () => {
    const options = processExecOptions({ command: "echo hi", egress: [], timeoutMs: 5000 }, { A: "1", "BAD-NAME": "x" });
    expect(options.Cmd).toEqual(["/usr/bin/timeout", "-s", "KILL", "35s", "/bin/bash", "-c", "echo hi"]);
    expect(options.User).toBe("1000:1000");
    expect(options.Env).toEqual(["A=1"]);
    expect(options.WorkingDir).toBe("/workspace");
    expect(options.AttachStdin).toBe(false);
  });

  it("runs root commands as root with their own HOME, handing workspace files back afterwards", () => {
    const options = processExecOptions(
      { command: "apt-get update", egress: [], user: "root" },
      { HOME: "/workspace/.home" },
    );
    expect(options.User).toBe("0:0");
    expect(options.Env).toEqual(["HOME=/root"]);
    const script = options.Cmd?.at(-1) ?? "";
    expect(script.endsWith("\napt-get update")).toBe(true);
    expect(script).toMatch(
      /^trap '\/usr\/bin\/find \/workspace -xdev -user 0 -exec \/usr\/bin\/chown -h 1000:1000 \{\} \+/,
    );
  });

  it("runs MCP servers as their own user, never the sandbox user's", () => {
    const options = processExecOptions({ command: "exec server", egress: [], user: "mcp" }, { TOKEN: "t" });
    expect(options.User).toBe("1001:1001");
    expect(options.Env).toEqual(["TOKEN=t"]);
    expect(options.Cmd?.at(-1)).toBe("exec server");
  });

  it("resolves cwd against the workspace and disables the backstop without a timeout", () => {
    const options = processExecOptions({ command: "pwd", egress: [], cwd: "src", stdin: "pipe" }, {});
    expect(options.Cmd?.slice(0, 4)).toEqual(["/usr/bin/timeout", "-s", "KILL", "0"]);
    expect(options.WorkingDir).toBe("/workspace/src");
    expect(options.AttachStdin).toBe(true);
  });
});

describe("mcpProcessEnv", () => {
  it("keeps the sandbox user's folders off PATH and gives the server its own HOME and TMPDIR", () => {
    const env = mcpProcessEnv("/opt/abotica/mcp/home");
    expect(env.PATH?.split(":")).toEqual([
      "/opt/abotica/mcp/home/.npm-global/bin",
      "/opt/abotica/mcp/home/.local/bin",
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/sbin",
      "/usr/bin",
      "/sbin",
      "/bin",
    ]);
    expect(env).toMatchObject({
      HOME: "/opt/abotica/mcp/home",
      TMPDIR: "/opt/abotica/mcp/tmp",
      NPM_CONFIG_PREFIX: "/opt/abotica/mcp/home/.npm-global",
      BASH_ENV: "",
    });
  });
});

describe("mcpExecOptions", () => {
  const server = { command: "exec server", egress: [], user: "mcp" as const, env: { TOKEN: "t" } };

  it("starts a server outside a workspace the agent writes, in its private home", () => {
    const options = mcpExecOptions(server, false);
    expect(processExecOptions(options, options.env!).WorkingDir).toBe("/opt/abotica/mcp/home");
    expect(options.env).toMatchObject({ HOME: "/opt/abotica/mcp/home", TOKEN: "t" });
  });

  it("keeps HOME and the working folder on the volume of the server's own workspace", () => {
    const options = mcpExecOptions(server, true);
    expect(processExecOptions(options, options.env!).WorkingDir).toBe("/workspace");
    expect(options.env).toMatchObject({ HOME: "/workspace/.home", TOKEN: "t" });
  });

  it("keeps a working folder the caller chose", () => {
    const options = mcpExecOptions({ ...server, cwd: "/opt/abotica/mcp/out/playwright" }, false);
    expect(options.cwd).toBe("/opt/abotica/mcp/out/playwright");
  });
});
