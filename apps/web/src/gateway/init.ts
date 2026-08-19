/**
 * SOT: trpc-init, gateway-context, error-formatter
 * WHAT   tRPC instance and request context. Deliberately thin.
 * WHY    Context carries request facts only. There is no `db` and no service client on it,
 *        because the gateway is not allowed to know how any of that works.
 * HOW    The request id is read, never minted. proxy.ts mints exactly one per request,
 *        always server-side - it never trusts a caller-supplied `x-request-id` - and a
 *        second source here would give the same request two ids, and the audit trail is
 *        keyed on it.
 */
import "server-only";

import { type Denial, denial } from "@guardrail/contracts/errors";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

export type GatewayContext = {
  readonly headers: Headers;
  readonly requestId: string;
  readonly ip: string;
};

function requestIdOf(headers: Headers): string {
  const requestId = headers.get("x-request-id");
  if (requestId === null) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "x-request-id is missing. proxy.ts sets it on every request it matches - check its matcher.",
    });
  }
  return requestId;
}

export function createContext(opts: { headers: Headers }): GatewayContext {
  return {
    headers: opts.headers,
    requestId: requestIdOf(opts.headers),
    ip: opts.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
  };
}

/**
 * Re-materialises the gateway's structured failure as a PLAIN object.
 *
 * This is not tidying. `GatewayError.failure` is handed to `new TRPCError({cause})`, and
 * tRPC's `getCauseFromUnknown` wraps a non-Error cause in an `UnknownCauseError` - a real
 * `Error` with the failure's fields `Object.assign`ed onto it. superjson then serialises the
 * whole error shape, sees `payload instanceof Error`, and applies its Error transformer,
 * which emits `{name, message}` and NOTHING else unless `superjson.allowErrorProps` was
 * called. It is not called anywhere in this platform.
 *
 * So `code`, `decision`, `retryAfterSeconds` and `permission` were all being stripped in
 * transit, and every consumer of `error.data.app.code` in the browser read `undefined`. The
 * gateway computed a structured denial, the UI could not see it, and all four call sites
 * fell back to printing `error.message` as red text - the one thing the client-mirror skill
 * forbids, caused by the transport rather than by the components.
 *
 * A plain object matches none of superjson's transformers and crosses whole. It is parsed
 * with `denial` - the wire schema in @guardrail/contracts - so the shape the browser reads is
 * the shape this function is typed to produce, rather than the two ends agreeing by
 * convention. `message` is
 * taken from the shape rather than the spread because `Error`'s constructor defines it
 * non-enumerably, so it is absent from `{...cause}`.
 */
export function appFailure(cause: unknown, message: string): Denial | null {
  if (cause === null || typeof cause !== "object" || !("code" in cause)) return null;
  const parsed = denial.safeParse({ ...cause, message });
  return parsed.success ? parsed.data : null;
}

const t = initTRPC.context<GatewayContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zod: error.cause instanceof ZodError ? error.cause.flatten() : null,
        /** Structured denial the UI renders as an upgrade prompt rather than a toast. */
        app: appFailure(error.cause, shape.message),
      },
    };
  },
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;
export { TRPCError };
