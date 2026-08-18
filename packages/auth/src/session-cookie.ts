/**
 * SOT: session-cookie, cookie-names, cookie-prefix, proxy-session-check
 * WHAT   The names Better Auth writes the session cookie under, derived from one prefix.
 * WHY    The proxy has to know whether a request carries a session before anything is
 *        allowed to read a database. It used to spell the two names out, so configuring a
 *        cookie prefix would have made that check false for everybody and redirected every
 *        signed-in user to /sign-in. The prefix is declared once here and handed to Better
 *        Auth as `advanced.cookiePrefix`, so the cookie and the check cannot disagree.
 * HOW    A leaf module on purpose: no `server-only`, no database, no environment, nothing
 *        that cannot run in the Next.js proxy. Importing the identity adapter there would
 *        have dragged the auth instance and its Postgres pool into the edge bundle.
 * WHERE  apps/web/src/proxy.ts via @guardrail/auth/session, auth.ts, identity.ts
 */

/** Better Auth's own default. Changing it here changes the cookie and the proxy together. */
export const SESSION_COOKIE_PREFIX = "better-auth";

/** Better Auth's fixed name for the session token cookie. */
const SESSION_COOKIE_BASE = "session_token";

/** Browsers only accept `__Secure-` over TLS, so Better Auth writes the plain name in dev. */
const SECURE_COOKIE_PREFIX = "__Secure-";

const SESSION_COOKIE_NAME = `${SESSION_COOKIE_PREFIX}.${SESSION_COOKIE_BASE}`;

/** Both forms, because which one is set depends on the origin, not on the configuration. */
export const SESSION_COOKIE_NAMES: readonly string[] = [
  SESSION_COOKIE_NAME,
  `${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_NAME}`,
];
