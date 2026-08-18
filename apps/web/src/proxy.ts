/**
 * SOT: proxy, middleware, request-id, pathname-header
 * WHAT   Next.js 16 renamed middleware.ts to proxy.ts. This is that file.
 * WHY    Two jobs: mint the request id that follows a request across every service, and
 *        expose the pathname so the dashboard layout can run the route guard.
 *        Authorisation does not happen here - the proxy cannot see the database.
 */
import { NextResponse, type NextRequest } from "next/server";

export default function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  requestHeaders.set("x-request-id", request.headers.get("x-request-id") ?? crypto.randomUUID());

  const isPublic =
    request.nextUrl.pathname === "/" ||
    request.nextUrl.pathname.startsWith("/sign-in") ||
    request.nextUrl.pathname.startsWith("/api/auth");

  const hasSession =
    request.cookies.has("better-auth.session_token") ||
    request.cookies.has("__Secure-better-auth.session_token");

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
