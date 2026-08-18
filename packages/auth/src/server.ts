/**
 * SOT: auth-server-entry, better-auth-handler, auth-instance-export
 * WHAT   The only entry point that hands out the Better Auth instance.
 * WHY    `auth` carries the Drizzle client it was built with, so exporting it from the
 *        package's main entry put `authDb` one import away from every page and every router
 *        in apps/web - arbitrary cross-tenant SQL inside the gateway. Behind this subpath it
 *        is reachable from exactly one file, the Better Auth catch-all route.
 * HOW    Nothing else may import this. Everything the gateway needs is `identify`, which
 *        stays on the main entry. `authDb` is never exported from any entry at all.
 * WHERE  apps/web/src/app/api/auth catch-all route
 */
import "server-only";

export { type Auth, auth } from "./auth";
