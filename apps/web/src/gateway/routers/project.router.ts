/**
 * SOT: project-gateway-router, project-routes
 * WHAT   The whole gateway surface of the project resource.
 * WHY    A route is a routing decision. Business logic lives in services/projects.
 * HOW    One line per endpoint: gatewayQuery / gatewayMutation. The architecture check
 *        reads this file as text and refuses control flow in it, comments included.
 * WHERE  packages/guardrail/src/gateway.ts, services/projects
 */
import { createTRPCRouter } from "../init";
import { gatewayMutation, gatewayQuery } from "../procedures";

export const projectRouter = createTRPCRouter({
  list: gatewayQuery("project", "read"),
  create: gatewayMutation("project", "create"),
  update: gatewayMutation("project", "update"),
  remove: gatewayMutation("project", "delete"),
});
