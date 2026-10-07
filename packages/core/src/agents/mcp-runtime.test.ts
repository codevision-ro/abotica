import type { McpToolInfo } from "@abotica/db";
import type { ExecOptions, SandboxProcess, Workspace } from "@abotica/sandbox";
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "./context";
import { GLOBAL_SECRETS } from "../platform/vault";
import { loadMcpTools } from "./mcp-runtime";

// The runtime only touches the database after a successful connection (the tool cache).
vi.mock("@abotica/db", () => ({ db: {} }));

const cached: McpToolInfo[] = [
  {
    name: "web_search",
    description: "Search the web",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  { name: "web_fetch", description: "Read pages", inputSchema: { type: "object" } },
];

// Nothing listens on port 1: any connection attempt fails at once.
const server = (tools: McpToolInfo[] | null): McpServer =>
  ({
    id: "00000000-0000-0000-0000-000000000001",
    slug: "search-test",
    name: "Search",
    transport: "http",
    url: "http://127.0.0.1:1/mcp",
    command: null,
    args: [],
    env: {},
    headers: {},
    network: { mode: "full", domains: [] },
    sandboxed: true,
    workspace: "server",
    global: false,
    builtin: null,
    auth: "headers",
    oauthClientId: null,
    oauthClientSecret: null,
    oauthScope: null,
    tools,
    toolsSyncedAt: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as McpServer;

describe("loadMcpTools", () => {
  it("offers a server with a full tool cache without connecting to it", async () => {
    const onLazyError = vi.fn();
    const mcp = await loadMcpTools([server(cached)], { secrets: GLOBAL_SECRETS, onLazyError });
    expect(Object.keys(mcp.tools)).toEqual(["search_test__web_search", "search_test__web_fetch"]);
    expect(mcp.sources["search_test__web_fetch"]).toEqual({ serverSlug: "search-test", tool: "web_fetch" });
    expect(mcp.errors).toEqual([]);
    expect(onLazyError).not.toHaveBeenCalled();

    // The first call starts the server; a server that cannot start fails that call and is reported.
    const execute = mcp.tools["search_test__web_search"]!.execute!;
    await expect(execute({ query: "x" }, { toolCallId: "1", messages: [] } as never)).rejects.toThrow();
    expect(onLazyError).toHaveBeenCalledWith("search-test", expect.anything());

    // A failed start is not remembered: the next call tries again.
    await expect(execute({ query: "x" }, { toolCallId: "2", messages: [] } as never)).rejects.toThrow();
    expect(onLazyError).toHaveBeenCalledTimes(2);
    await mcp.close();
  });

  it("connects up front when the cache has no definitions, and reports a server that is down", async () => {
    const mcp = await loadMcpTools([server([{ name: "web_search", description: "Search the web" }])], {
      secrets: GLOBAL_SECRETS,
    });
    expect(mcp.tools).toEqual({});
    expect(mcp.errors.map((e) => e.server)).toEqual(["search-test"]);
  });
});

/**
 * A stdio MCP server process that answers the handshake and the tool list, and returns `reply` as
 * the text of every tool call.
 */
function fakeServerProcess(reply: string): SandboxProcess {
  const stdout = new TransformStream<Uint8Array, Uint8Array>();
  const out = stdout.writable.getWriter();
  const send = (message: object) => out.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  let buffer = "";
  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        const request = JSON.parse(line) as { id?: number; method: string; params?: { protocolVersion?: string } };
        if (request.id === undefined) continue;
        const result =
          request.method === "initialize"
            ? {
                protocolVersion: request.params?.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "fake", version: "1" },
              }
            : request.method === "tools/list"
              ? { tools: cached }
              : { content: [{ type: "text", text: reply }] };
        void send({ jsonrpc: "2.0", id: request.id, result });
      }
    },
  });
  return {
    stdin,
    stdout: stdout.readable,
    stderr: new ReadableStream({ start: (c) => c.close() }),
    wait: () => new Promise(() => {}),
    kill: async () => {
      await out.close().catch(() => {});
    },
  };
}

describe("loadMcpTools in a run's workspace", () => {
  const stdio = (): McpServer => ({
    ...server(cached),
    transport: "stdio",
    url: null,
    command: "npx",
    args: ["-y", "some-server"],
    workspace: "run",
  });

  async function call(reply: string) {
    const execs: ExecOptions[] = [];
    const workspace: Workspace = {
      key: "project-x",
      paths: {
        workspace: "/workspace",
        bundles: "/opt/abotica/bundles",
        home: "/workspace/.home",
        mcpOutput: "/opt/abotica/mcp/out",
      },
      exec: async (options) => {
        execs.push(options);
        return fakeServerProcess(reply);
      },
    };
    const mcp = await loadMcpTools([stdio()], { secrets: GLOBAL_SECRETS, runWorkspace: async () => workspace });
    const output = await mcp.tools["search_test__web_search"]!.execute!({ query: "x" }, {
      toolCallId: "1",
      messages: [],
    } as never);
    await mcp.close();
    return { execs, output: output as { content: { type: string; text: string }[] } };
  }

  it("starts the server as the MCP user in its own folder outside the workspace volume", async () => {
    const { execs } = await call("done");
    expect(execs).toHaveLength(1);
    expect(execs[0]).toMatchObject({ user: "mcp", stdin: "pipe" });
    expect(execs[0]!.cwd).toBeUndefined();
    expect(execs[0]!.command).toBe(
      "mkdir -p -- /opt/abotica/mcp/out/search-test && cd -- /opt/abotica/mcp/out/search-test && exec npx -y some-server",
    );
  });

  it("tells the agent where the files it names relative to its folder are", async () => {
    const { output } = await call("- [Screenshot of viewport](./page.png)");
    expect(output.content).toHaveLength(2);
    expect(output.content[1]!.text).toContain("/opt/abotica/mcp/out/search-test/<name>");
  });

  it("leaves results that name no relative path as they are", async () => {
    const { output } = await call("Page title: Example Domain");
    expect(output.content).toEqual([{ type: "text", text: "Page title: Example Domain" }]);
  });
});
