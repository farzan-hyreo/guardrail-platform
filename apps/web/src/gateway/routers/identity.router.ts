/**
 * SOT: identity-gateway-router, member-routes, invitation-routes
 */
import { createTRPCRouter } from "../init";
import { gatewayMutation, gatewayQuery } from "../procedures";

export const memberRouter = createTRPCRouter({
  list: gatewayQuery("member", "read"),
  invite: gatewayMutation("member", "create"),
  remove: gatewayMutation("member", "delete"),
});

export const invitationRouter = createTRPCRouter({
  list: gatewayQuery("invitation", "read"),
  revoke: gatewayMutation("invitation", "delete"),
});
