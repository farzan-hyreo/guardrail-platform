/**
 * SOT: trpc-client, trpc-provider
 */
"use client";

import { env } from "@guardrail/env";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { useState } from "react";
import superjson from "superjson";

import type { AppRouter } from "@/gateway/routers/_app";
import { createQueryClient } from "./query-client";

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  if (typeof window === "undefined") return createQueryClient();
  browserQueryClient ??= createQueryClient();
  return browserQueryClient;
}

export function TRPCReactProvider({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  const [client] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          // Through @guardrail/env, not process.env: this is a .tsx, which the no-process-env
          // plugin did not cover until its glob was widened. env.publicAppUrl spells the key
          // out literally for exactly this case - Next substitutes NEXT_PUBLIC_* by matching
          // the literal text, so a dynamic read yields undefined in the browser.
          url: `${typeof window === "undefined" ? env.publicAppUrl() : ""}/api/trpc`,
          transformer: superjson,
        }),
      ],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
