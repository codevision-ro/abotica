import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuth } from "@/server/auth";

/**
 * The verified session (checked against the database by better-auth), or null. Memoized per
 * request, so every page, query and action of one render shares a single check.
 */
export const getSession = cache(async () => (await getAuth()).api.getSession({ headers: await headers() }));

/**
 * The session check behind query() and action(), which every read and write goes through. A layout or
 * page check alone is not enough, since segments render without their layout on navigation.
 */
export async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session.user;
}

/** Same as requireUser for route handlers, where redirect is not wanted. */
export async function requireApiUser() {
  const session = await getSession();
  if (!session) throw new Response("Unauthorized", { status: 401 });
  return session.user;
}
