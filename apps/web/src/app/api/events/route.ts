import { subscribe } from "@abotica/core";
import { unauthorized } from "@/server/session";

export const dynamic = "force-dynamic";

/** Server-sent events relaying worker events (runs, tasks, approvals, kill switch) to the UI. */
export async function GET(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) => controller.enqueue(encoder.encode(data));
      const unsubscribe = subscribe((event) => send(`data: ${JSON.stringify(event)}\n\n`));
      const heartbeat = setInterval(() => send(": ping\n\n"), 25_000);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.signal.addEventListener("abort", () => {
        cleanup();
        controller.close();
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
