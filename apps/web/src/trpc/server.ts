/**
 * SOT: trpc-server-caller, rsc-caller
 * Server components call the API in-process - but still through the gateway block, so a
 * page cannot become a second, unguarded path to the services.
 */
import "server-only";

import { headers } from "next/headers";
import { cache } from "react";

import { createContext } from "@/gateway/init";
import { createCaller } from "@/gateway/routers/_app";

const getContext = cache(async () => createContext({ headers: await headers() }));

export const api = createCaller(getContext);
