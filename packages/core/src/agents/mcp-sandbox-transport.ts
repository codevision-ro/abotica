/**
 * MCP over stdio for a server running inside the sandbox: newline-delimited JSON-RPC on the
 * process's stdin and stdout. Stderr is kept (the tail) so a crash explains itself.
 */
import { type JSONRPCMessage, type MCPTransport, validateJSONRPCMessage } from "@ai-sdk/mcp";
import type { SandboxProcess } from "@abotica/sandbox";

const STDERR_TAIL = 2_000;

/** Splits a byte stream into lines; partial lines and multi-byte characters wait for the next chunk. */
export class LineDecoder {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;
    return lines.map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");
  }

  /** What is left after the stream ended (a last line without a newline). */
  flush(): string[] {
    const rest = (this.buffer + this.decoder.decode()).trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }
}

export class SandboxMcpTransport implements MCPTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private process: SandboxProcess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly encoder = new TextEncoder();
  private stderr = "";
  private closed = false;

  /** `spawn` starts the server process with `stdin: "pipe"`. */
  constructor(private readonly spawn: () => Promise<SandboxProcess>) {}

  /** The end of what the server wrote to stderr, for error messages. */
  stderrTail(): string {
    return this.stderr.trim();
  }

  async start(): Promise<void> {
    if (this.process) throw new Error("SandboxMcpTransport already started");
    const proc = await this.spawn();
    if (!proc.stdin) {
      await proc.kill();
      throw new Error("The MCP server process has no stdin");
    }
    this.process = proc;
    this.writer = proc.stdin.getWriter();
    const stdoutDone = this.readStdout(proc.stdout);
    void this.readStderr(proc.stderr);
    // Answers written right before the exit are delivered before the client hears about the close.
    const drained = () => Promise.race([stdoutDone, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    void proc.wait().then(
      async ({ exitCode }) => {
        await drained();
        this.exited(`The MCP server exited with code ${exitCode}`);
      },
      (error: unknown) => this.exited(error instanceof Error ? error.message : String(error)),
    );
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.writer) throw new Error(this.withStderr("The MCP server is not running"));
    await this.writer.write(this.encoder.encode(`${JSON.stringify(message)}\n`));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writer?.close().catch(() => {});
    await this.process?.kill().catch(() => {});
    this.onclose?.();
  }

  private withStderr(message: string): string {
    const tail = this.stderrTail();
    return tail ? `${message}: ${tail}` : message;
  }

  private exited(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.onerror?.(new Error(this.withStderr(reason)));
    this.onclose?.();
  }

  private handleLine(line: string) {
    let message: JSONRPCMessage;
    try {
      message = validateJSONRPCMessage(JSON.parse(line));
    } catch (error) {
      // Some servers log to stdout; that is their bug, not a reason to drop the connection.
      this.onerror?.(new Error(`Invalid message from the MCP server: ${line.slice(0, 200)}`, { cause: error }));
      return;
    }
    this.onmessage?.(message);
  }

  private async readStdout(stream: ReadableStream<Uint8Array>) {
    const lines = new LineDecoder();
    try {
      for await (const chunk of stream) for (const line of lines.push(chunk)) this.handleLine(line);
      for (const line of lines.flush()) this.handleLine(line);
    } catch (error) {
      if (!this.closed) this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        this.stderr = (this.stderr + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL);
      }
    } catch {
      // Losing stderr only makes error messages shorter.
    }
  }
}
