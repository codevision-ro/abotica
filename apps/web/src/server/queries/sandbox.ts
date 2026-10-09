import "server-only";
import { getSandboxStatus } from "@abotica/core";
import { query } from "@/server/query";

/** What the worker found when it last checked the sandbox; null before its first check. */
export type SandboxStatusView = Awaited<ReturnType<typeof getSandboxStatus>>;

/** Settings > System: the latest sandbox status the worker stored. */
export const getSandboxStatusView = query(() => getSandboxStatus());
