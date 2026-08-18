/**
 * SOT: query-client, tanstack-config, cache-defaults
 * WHAT   One TanStack Query configuration for server and browser.
 * WHY    Optimistic UI needs consistent stale times and one superjson boundary.
 * WHERE  trpc/react.tsx, trpc/server.ts
 */
import { QueryClient, defaultShouldDehydrateQuery } from "@tanstack/react-query";
import superjson from "superjson";

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30 * 1000, refetchOnWindowFocus: false },
      dehydrate: {
        serializeData: superjson.serialize,
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === "pending",
      },
      hydrate: { deserializeData: superjson.deserialize },
    },
  });
}
