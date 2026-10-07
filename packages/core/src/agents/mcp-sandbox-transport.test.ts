import type { JSONRPCMessage } from "@ai-sdk/mcp";
import type { SandboxProcess } from "@abotica/sandbox";
import { describe, expect, it } from "vitest";
import { LineDecoder, SandboxMcpTransport } from "./mcp-sandbox-transport";

const encode = (s: string) => new TextEncoder().encode(s);

/** A process whose stdout/stderr the test writes and whose stdin the test reads. */
function fakeProcess() {
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  const written: string[] = [];
  let killed = false;
  const exited = new Promise<{ exitCode: number; timedOut: boolean }>((resolve) => {
    exit = (exitCode) => {
      stdout.close();
      stderr.close();
      resolve({ exitCode, timedOut: false });
    };
  });
  const proc: SandboxProcess = {
    stdin: new WritableStream<Uint8Array>({ write: (chunk) => void written.push(new TextDecoder().decode(chunk)) }),
    stdout: new ReadableStream({ start: (c) => void (stdout = c) }),
    stderr: new ReadableStream({ start: (c) => void (stderr = c) }),
    wait: () => exited,
    kill: async () => {
      killed = true;
    },
  };
  return {
    proc,
    written,
    killed: () => killed,
    out: (s: string) => stdout.enqueue(encode(s)),
    err: (s: string) => stderr.enqueue(encode(s)),
    exit,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("LineDecoder", () => {
  it("joins partial lines and skips blank ones", () => {
    const lines = new LineDecoder();
    expect(lines.push(encode('{"a":'))).toEqual([]);
    expect(lines.push(encode('1}\r\n\n{"b":2}\n{"c"'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(lines.flush()).toEqual(['{"c"']);
  });

  it("keeps multi-byte characters split across chunks", () => {
    const lines = new LineDecoder();
    const bytes = encode('"ș"\n');
    expect(lines.push(bytes.slice(0, 2))).toEqual([]);
    expect(lines.push(bytes.slice(2))).toEqual(['"ș"']);
  });
});

describe("SandboxMcpTransport", () => {
  it("writes newline-delimited JSON and parses answers", async () => {
    const fake = fakeProcess();
    const transport = new SandboxMcpTransport(async () => fake.proc);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (m) => received.push(m);
    await transport.start();

    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(fake.written).toEqual(['{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n']);

    fake.out('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n');
    await tick();
    expect(received).toEqual([{ jsonrpc: "2.0", id: 1, result: { tools: [] } }]);
  });

  it("reports stdout noise as an error without closing", async () => {
    const fake = fakeProcess();
    const transport = new SandboxMcpTransport(async () => fake.proc);
    const errors: Error[] = [];
    let closed = false;
    transport.onerror = (e) => errors.push(e);
    transport.onclose = () => void (closed = true);
    await transport.start();
    fake.out("Server listening\n");
    await tick();
    expect(errors[0]?.message).toContain("Server listening");
    expect(closed).toBe(false);
  });

  it("explains an exit with the end of stderr", async () => {
    const fake = fakeProcess();
    const transport = new SandboxMcpTransport(async () => fake.proc);
    const errors: Error[] = [];
    let closed = false;
    transport.onerror = (e) => errors.push(e);
    transport.onclose = () => void (closed = true);
    await transport.start();
    fake.err("npm ERR! 404 Not Found\n");
    await tick();
    fake.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(true);
    expect(errors.at(-1)?.message).toBe("The MCP server exited with code 1: npm ERR! 404 Not Found");
    await expect(transport.send({ jsonrpc: "2.0", id: 2, method: "ping" })).rejects.toThrow("npm ERR! 404");
  });

  it("kills the process on close, once", async () => {
    const fake = fakeProcess();
    const transport = new SandboxMcpTransport(async () => fake.proc);
    let closes = 0;
    transport.onclose = () => void (closes += 1);
    await transport.start();
    await transport.close();
    await transport.close();
    expect(fake.killed()).toBe(true);
    expect(closes).toBe(1);
  });
});
