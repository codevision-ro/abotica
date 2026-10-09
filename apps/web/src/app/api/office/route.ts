import { getOffice } from "@/server/queries/office";
import { unauthorized } from "@/server/session";

export const dynamic = "force-dynamic";

/** The office state, polled by the office page; never cached, it changes with every run step. */
export async function GET() {
  const denied = await unauthorized();
  if (denied) return denied;
  return Response.json(await getOffice(), { headers: { "cache-control": "no-store" } });
}
