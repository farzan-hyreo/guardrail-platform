/**
 * SOT: trpc-route, api-entrypoint, single-door
 * WHAT   The one HTTP door into the platform. Everything behind it is on the bus.
 */
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { NextRequest } from "next/server";

import { createContext } from "@/gateway/init";
import { appRouter } from "@/gateway/routers/_app";

function handler(request: NextRequest) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: () => createContext({ headers: request.headers }),
    onError({ error, path }) {
      console.error(`[gateway] ${path ?? "<no-path>"}: ${error.message}`);
    },
  });
}

export { handler as GET, handler as POST };
