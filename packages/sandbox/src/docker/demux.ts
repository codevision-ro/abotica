import type { Readable, Writable } from "node:stream";

const HEADER = 8;

/**
 * Splits the multiplexed stream of a non-TTY exec (frames of an 8-byte header: stream type, three
 * zero bytes, big-endian payload length) into stdout and stderr. Pauses the source while either
 * output is full, so a slow reader slows the process down instead of growing memory. Ends both
 * outputs when the source ends or fails.
 */
export function demuxDockerStream(source: Readable, stdout: Writable, stderr: Writable): void {
  let pending: Buffer = Buffer.alloc(0);
  let waiting = 0;
  let ended = false;

  const finish = () => {
    if (ended) return;
    ended = true;
    stdout.end();
    stderr.end();
  };

  const write = (target: Writable, payload: Buffer) => {
    if (target.writableEnded || target.destroyed) return;
    if (!target.write(payload)) {
      waiting++;
      source.pause();
      target.once("drain", () => {
        if (--waiting === 0 && !ended) source.resume();
      });
    }
  };

  source.on("data", (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= HEADER) {
      const size = pending.readUInt32BE(4);
      if (pending.length < HEADER + size) break;
      const type = pending[0];
      const payload = pending.subarray(HEADER, HEADER + size);
      pending = pending.subarray(HEADER + size);
      if (type === 1) write(stdout, payload);
      else if (type === 2) write(stderr, payload);
    }
  });
  source.on("end", finish);
  source.on("close", finish);
  source.on("error", finish);
}
