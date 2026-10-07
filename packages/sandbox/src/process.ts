import type { ExecOptions, Workspace } from "./types";

export type CommandResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };

/** Exit code reported for a command killed by its timeout, as coreutils `timeout` does. */
export const TIMEOUT_EXIT_CODE = 124;

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Runs a command to completion and collects both streams. Stdin is always empty here; use
 * `workspace.exec` directly to pipe input.
 */
export async function runCommand(
  workspace: Workspace,
  options: ExecOptions & { maxOutputBytes?: number },
): Promise<CommandResult> {
  const { maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, ...exec } = options;
  const proc = await workspace.exec({ ...exec, stdin: undefined });
  const [stdout, stderr, status] = await Promise.all([
    collectText(proc.stdout, maxOutputBytes),
    collectText(proc.stderr, maxOutputBytes),
    proc.wait(),
  ]);
  return {
    exitCode: status.timedOut ? TIMEOUT_EXIT_CODE : status.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    timedOut: status.timedOut,
    truncated: stdout.truncated || stderr.truncated,
  };
}

/**
 * Reads a stream to the end, keeping at most `maxBytes` from its start. The rest is read and
 * dropped so the process never blocks on a full pipe.
 */
export async function collectBytes(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (truncated) continue;
      const room = maxBytes - size;
      if (value.byteLength > room) {
        truncated = true;
        if (room > 0) chunks.push(value.subarray(0, room));
        size = maxBytes;
      } else {
        chunks.push(value);
        size += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: concatBytes(chunks, size), truncated };
}

export async function collectText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const { bytes, truncated } = await collectBytes(stream, maxBytes);
  const kept = truncated ? trimPartialUtf8(bytes) : bytes;
  return { text: new TextDecoder().decode(kept), truncated };
}

export function concatBytes(chunks: Uint8Array[], size = chunks.reduce((n, c) => n + c.byteLength, 0)): Uint8Array {
  if (chunks.length === 1 && chunks[0]!.byteLength === size) return chunks[0]!;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Drops an incomplete UTF-8 sequence at the end, left by cutting a stream at a byte limit. */
export function trimPartialUtf8(bytes: Uint8Array): Uint8Array {
  // Look back over at most three continuation bytes for the lead byte of the last character.
  for (let i = bytes.length - 1, seen = 0; i >= 0 && seen < 4; i--, seen++) {
    const byte = bytes[i]!;
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return bytes.length - i < length ? bytes.subarray(0, i) : bytes;
  }
  return bytes;
}
