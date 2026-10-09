import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { authCookiePrefix, isHttpsApp } from "@/server/auth-cookies";
import { isCrossOriginWrite } from "@/server/same-origin";

/** Pages reachable without a session: the proxy still sets their Content-Security-Policy. */
const PUBLIC_PAGES = ["/login", "/signup", "/2fa"];

const isPublicPage = (pathname: string) => PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/**
 * The Content-Security-Policy of a page, with a fresh nonce per request. Next reads the nonce from
 * the request's copy of this header and adds it to its own scripts; the root layout passes `x-nonce`
 * to next-themes for its inline theme script. 'strict-dynamic' lets those scripts load the app's
 * chunks; any other inline or injected script (an XSS) has no nonce and does not run.
 * - style-src keeps 'unsafe-inline': React renders style attributes, and sonner, next-themes and
 *   Shiki insert style elements without a nonce. Styles cannot run code; scripts are the strict part.
 * - 'wasm-unsafe-eval' compiles WebAssembly only (Shiki's default regex engine), never JS eval.
 * - img-src has no remote hosts: an image in an agent's reply loads only from the app or inline
 *   data, so a reply written by a prompt injection cannot send data out through an image URL.
 * - connect-src 'self' covers the live updates (/api/events) and chat streams; blob: and data: are
 *   files picked in the composer, read back with fetch().
 * - Previews are links to their own origin (never framed) and OAuth sign-ins are full-page
 *   navigations, which no directive here restricts.
 * - Development adds 'unsafe-eval' (React rebuilds server error stacks with eval) and ws: for hot reload.
 */
function contentSecurityPolicy(nonce: string, https: boolean): string {
  const dev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' blob: data:${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/**
 * Refuses writes from other origins (see same-origin.ts), gates on the session cookie, and sets the
 * Content-Security-Policy (and HSTS over HTTPS: both depend on APP_URL, read at run time, unlike
 * next.config.ts headers, which are fixed at build). The session check is optimistic only: real
 * checks happen in every page, action and route via requireUser().
 */
export function proxy(request: NextRequest) {
  if (isCrossOriginWrite(request)) return new NextResponse("Cross-origin request refused", { status: 403 });
  const { pathname, search } = request.nextUrl;
  if (!isPublicPage(pathname) && !getSessionCookie(request, { cookiePrefix: authCookiePrefix() })) {
    const url = new URL("/login", request.url);
    // With the query: a private preview's link carries the path to return to on the preview.
    if (pathname !== "/") url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  const https = isHttpsApp();
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce, https);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-nonce", nonce);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  // Only for an HTTPS APP_URL: a browser would otherwise refuse plain HTTP to the host for a year.
  if (https) response.headers.set("strict-transport-security", "max-age=31536000");
  return response;
}

// api/files checks the session itself; kept out so the proxy does not buffer (and cut) large uploads.
// auth/callback is reached on 127.0.0.1, where the session cookie of another host is not sent: its single-use state authenticates it.
// The other API routes outside it return no pages, and next.config.ts gives every response the static security headers.
export const config = {
  matcher: [
    "/((?!api/auth|api/webhooks|api/health|api/files|auth/callback|_next/static|_next/image|favicon.ico|icon|apple-icon|logo/).*)",
  ],
};
