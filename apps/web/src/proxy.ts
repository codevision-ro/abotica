import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_PREFIX } from "@/server/auth-cookies";
import { isCrossOriginWrite } from "@/server/same-origin";

/**
 * Refuses writes from other origins (see same-origin.ts), then gates on the session cookie. The
 * session check is optimistic only: real checks happen in every page, action and route via requireUser().
 */
export function proxy(request: NextRequest) {
  if (isCrossOriginWrite(request)) return new NextResponse("Cross-origin request refused", { status: 403 });
  if (!getSessionCookie(request, { cookiePrefix: AUTH_COOKIE_PREFIX })) {
    const url = new URL("/login", request.url);
    // With the query: a private preview's link carries the path to return to on the preview.
    const { pathname, search } = request.nextUrl;
    if (pathname !== "/") url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

// api/files checks the session itself; kept out so the proxy does not buffer (and cut) large uploads.
// auth/callback is reached on 127.0.0.1, where the session cookie of another host is not sent: its single-use state authenticates it.
export const config = {
  matcher: [
    "/((?!api/auth|api/webhooks|api/health|api/files|auth/callback|login|signup|2fa|_next/static|_next/image|favicon.ico|icon|apple-icon|logo/).*)",
  ],
};
