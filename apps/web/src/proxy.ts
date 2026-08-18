/**
 * SOT: proxy, middleware, request-id, pathname-header, session-cookie-check
 * WHAT   Next.js 16 renamed middleware.ts to proxy.ts. This is that file.
 * WHY    Two jobs: mint the request id that follows a request across every service, and
 *        expose the pathname so the dashboard layout can run the route guard.
 *        Authorisation does not happen here - the proxy cannot see the database.
 * HOW    This is the only place in the platform that mints a request id, and it is always
 *        server-minted with `crypto.randomUUID()` - an inbound `x-request-id` is discarded,
 *        never read. It used to pass a caller-supplied id through when it matched a shape
 *        regex, but a format check is not a trust boundary: this value keys the audit trail
 *        and, once signed into the envelope, the reply MAC. A regex-valid id is still
 *        attacker-chosen, which let a captured signed reply for one operation be replayed
 *        against a different one reusing the same id. The session cookie names come from the
 *        auth adapter rather than from strings typed here, so a configured cookie prefix
 *        cannot lock everybody out.
 * WHERE  gateway/init.ts reads x-request-id, the dashboard layout reads x-pathname
 */
import { SESSION_COOKIE_NAMES } from "@guardrail/auth/session";
import { type NextRequest, NextResponse } from "next/server";

export default function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  requestHeaders.set("x-request-id", crypto.randomUUID());

  const isPublic =
    request.nextUrl.pathname === "/" ||
    request.nextUrl.pathname.startsWith("/sign-in") ||
    request.nextUrl.pathname.startsWith("/api/auth");

  const hasSession = SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name));

  if (!isPublic && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    return NextResponse.redirect(url);
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
