/**
 * SOT: auth-route, better-auth-handler-route, superseded-endpoint-refusal
 * WHAT   The catch-all Better Auth mounts its own HTTP endpoints on, minus the ones the
 *        registry has taken over.
 * WHY    The only file in apps/web allowed to import @guardrail/auth/server. Everywhere
 *        else asks `identify` for a normalised identity, because the instance carries the
 *        database client with it and the gateway is not allowed one.
 *        The filter is the second reason: Better Auth's organisation endpoints ran outside
 *        the block entirely - no role gate, no permission, no rate limit, no plan gate and
 *        no evt.*, so an organisation could be deleted with no audit row and any signed-in
 *        user could loop `organization/create`. Those paths are now registry operations, and
 *        an operation with a gate on one path and none on another has no gate.
 * HOW    Which paths are refused, and which are deliberately still mounted, is decided in
 *        superseded.ts and checked against the registry while the module loads. Nothing is
 *        decided here: this reads the verdict and either answers 410 or delegates.
 * WHERE  apps/web/src/app/api/auth/superseded.ts
 */
import { auth } from "@guardrail/auth/server";
import { toNextJsHandler } from "better-auth/next-js";

import { supersedes } from "../superseded";

const handler = toNextJsHandler(auth);

/**
 * 410 rather than 404: the endpoint existed, it is gone on purpose, and the replacement is
 * named. A 404 here would read as a routing bug to whoever hits it next.
 */
function refuse(endpoint: { path: string; by: string; instead: string }): Response {
  return Response.json(
    {
      error: "ENDPOINT_SUPERSEDED",
      message: `/api/auth/${endpoint.path} is no longer served. Call the gateway's ${endpoint.instead} instead - it carries the role, permission, rate limit, plan and audit checks this path did not.`,
      permission: endpoint.by,
    },
    { status: 410 },
  );
}

export function GET(request: Request): Promise<Response> | Response {
  const endpoint = supersedes(new URL(request.url).pathname);
  return endpoint === null ? handler.GET(request) : refuse(endpoint);
}

export function POST(request: Request): Promise<Response> | Response {
  const endpoint = supersedes(new URL(request.url).pathname);
  return endpoint === null ? handler.POST(request) : refuse(endpoint);
}
