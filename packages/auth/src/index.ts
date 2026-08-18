/**
 * SOT: auth-barrel, auth-index, auth-public-entry
 * WHAT   The public entry of @guardrail/auth: everything the gateway is allowed to see.
 * WHY    apps/web depends on this package, so whatever is exported here is one import away
 *        from every page and every router. `export * from "./auth"` put `authDb` on that
 *        list, which gave the gateway a database after all - the one thing the server
 *        boundary claims it cannot have. The instance now lives behind ./server.
 * HOW    Add an export here only when the gateway itself needs it, and never export authDb
 *        or the Drizzle schema from a public entry. `identity.ts` importing authDb
 *        relatively is fine; that module is inside the boundary.
 * WHERE  apps/web/src/gateway/deps.ts, apps/web dashboard layout
 */
export { identify } from "./identity";
export { SESSION_COOKIE_NAMES } from "./session-cookie";
