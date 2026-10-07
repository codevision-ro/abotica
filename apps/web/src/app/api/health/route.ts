import { getHealth } from "@/server/queries/health";

export const dynamic = "force-dynamic";

/** Unauthenticated liveness check for uptime monitors and container healthchecks. Reveals nothing but up/down. */
export async function GET() {
  const { database, redis } = await getHealth();
  const ok = database && redis;
  return Response.json({ ok, database, redis }, { status: ok ? 200 : 503 });
}
