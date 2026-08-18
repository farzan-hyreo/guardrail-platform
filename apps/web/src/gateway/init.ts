/**
 * SOT: trpc-init, gateway-context, error-formatter
 * WHAT   tRPC instance and request context. Deliberately thin.
 * WHY    Context carries request facts only. There is no `db` and no service client on it,
 *        because the gateway is not allowed to know how any of that works.
 */
import "server-only";

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

export type GatewayContext = {
  readonly headers: Headers;
  readonly requestId: string;
  readonly ip: string;
};

export async function createContext(opts: { headers: Headers }): Promise<GatewayContext> {
  return {
    headers: opts.headers,
    requestId: opts.headers.get("x-request-id") ?? crypto.randomUUID(),
    ip: opts.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
  };
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
        app: error.cause && typeof error.cause === "object" && "code" in error.cause ? error.cause : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;
export { TRPCError };
