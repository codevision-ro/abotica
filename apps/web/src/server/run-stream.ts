import "server-only";
import { readRunStream } from "@abotica/core";
import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";

/** Relays a worker run's UI message chunks (from Redis) as an AI SDK UI stream response. */
export function runStreamResponse(runId: string, signal: AbortSignal) {
  const iterator = readRunStream(runId, { signal });
  const stream = new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
  return createUIMessageStreamResponse({ stream });
}
