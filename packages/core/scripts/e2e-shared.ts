import { db, runs } from "@abotica/db";
import { eq } from "@abotica/db/orm";

/** Helpers of the end-to-end scripts. */

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The run once it is no longer queued or running, checked every second; throws after `maxSeconds`. */
export async function waitRun(id: string, maxSeconds: number) {
  for (let i = 0; i < maxSeconds; i++) {
    const [r] = await db.select().from(runs).where(eq(runs.id, id));
    if (r && !["queued", "running"].includes(r.status)) return r;
    await wait(1000);
  }
  throw new Error("timeout");
}
