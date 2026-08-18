/**
 * SOT: project-gateway-router, project-routes
 * The whole gateway surface for projects. Business logic lives in services/projects.
 */
import { createTRPCRouter } from "../init";
import { gatewayMutation, gatewayQuery } from "../procedures";

export const projectRouter = createTRPCRouter({
  list: gatewayQuery("project", "read"),
  create: gatewayMutation("project", "create"),
  update: gatewayMutation("project", "update"),
  remove: gatewayMutation("project", "delete"),
});
