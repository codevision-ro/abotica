import { isUuid } from "@/lib/uuid";
import { getActiveRunId } from "@/server/queries/chat";
import { unauthorized } from "@/server/session";
import { runStreamResponse } from "@/server/run-stream";

export const dynamic = "force-dynamic";

/** Resumes the stream of the conversation's active run (after reload or an approval). */
export async function GET(request: Request, ctx: RouteContext<"/api/chat/[id]/stream">) {
  const denied = await unauthorized();
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!isUuid(id)) return new Response(null, { status: 204 });
  const runId = await getActiveRunId(id);
  if (!runId) return new Response(null, { status: 204 });
  // A queued run has no stream yet; the reader waits for its first chunk.
  return runStreamResponse(runId, request.signal);
}
