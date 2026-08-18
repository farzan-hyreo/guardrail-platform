/**
 * SOT: gateway-procedures, gateway-query, gateway-mutation, one-line-route
 * WHAT   Turns a (resource, operation) pair into a fully wired tRPC procedure.
 * WHY    A gateway route should be a routing decision and nothing else. Because the input
 *        schema comes from the contract and the handler is always "dispatch", there is no
 *        line in a gateway router where business logic could be written even by accident.
 * HOW    list: gatewayQuery("project", "read")  -  that is the whole endpoint.
 * WHERE  apps/web/src/gateway/routers/*
 */
import "server-only";

import { contractFor } from "@guardrail/contracts";
import { GatewayError, dispatch } from "@guardrail/guardrail";
import { ruleFor, type OperationOf, type ResourceKey } from "@guardrail/registry";

import { gatewayDeps } from "./deps";
import { TRPCError, publicProcedure } from "./init";

function toTRPC(error: unknown): never {
  if (error instanceof GatewayError) {
    throw new TRPCError({
      code: error.trpcCode as "FORBIDDEN",
      message: error.message,
      cause: error.failure,
    });
  }
  throw error;
}

function build<K extends ResourceKey, O extends OperationOf<K>>(
  resource: K,
  operation: O,
  expected: "query" | "mutation",
) {
  const rule = ruleFor(resource, operation);
  if (rule.kind !== expected) {
    // Caught at module load, not at 2am: the registry says this is the other kind.
    throw new Error(
      `${resource}.${String(operation)} is declared as a ${rule.kind}; use gateway${
        rule.kind === "query" ? "Query" : "Mutation"
      } instead.`,
    );
  }
  return publicProcedure.input(contractFor(resource, operation).input);
}

export function gatewayQuery<K extends ResourceKey, O extends OperationOf<K>>(resource: K, operation: O) {
  return build(resource, operation, "query").query(async ({ ctx, input }) => {
    try {
      return await dispatch({ deps: gatewayDeps, ...ctx, resource, operation, input });
    } catch (error) {
      return toTRPC(error);
    }
  });
}

export function gatewayMutation<K extends ResourceKey, O extends OperationOf<K>>(resource: K, operation: O) {
  return build(resource, operation, "mutation").mutation(async ({ ctx, input }) => {
    try {
      return await dispatch({ deps: gatewayDeps, ...ctx, resource, operation, input });
    } catch (error) {
      return toTRPC(error);
    }
  });
}
