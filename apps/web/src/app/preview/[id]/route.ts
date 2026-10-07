import { issuePreviewTicket, previewUrl } from "@abotica/core";
import { safeReturnPath } from "@abotica/core/return-path";
import { getTranslations } from "next-intl/server";
import { isUuid } from "@/lib/uuid";
import { getPreview } from "@/server/queries/previews";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * The way into a private preview: with the user's session, hands the preview host a one-time
 * ticket in the redirect, which it trades for its own cookie. The session itself never goes there.
 */
export async function GET(request: Request, ctx: RouteContext<"/preview/[id]">) {
  const url = new URL(request.url);
  if (!(await getSession())) {
    const login = new URL("/login", url);
    login.searchParams.set("next", `${url.pathname}${url.search}`);
    return Response.redirect(login, 303);
  }
  const { id } = await ctx.params;
  const preview = isUuid(id) ? await getPreview(id) : null;
  if (!preview || preview.expiresAt.getTime() <= Date.now()) {
    const t = await getTranslations("previews.errors");
    return new Response(t("notFound"), { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const target = new URL(previewUrl(preview, "/__abotica/auth"));
  target.searchParams.set("ticket", issuePreviewTicket(preview.id));
  target.searchParams.set("return", safeReturnPath(url.searchParams.get("return")));
  return new Response(null, {
    status: 303,
    headers: { location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
