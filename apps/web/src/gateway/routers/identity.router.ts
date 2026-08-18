/**
 * SOT: identity-gateway-router, member-routes, invitation-routes, organization-routes,
 *      membership-routes
 * WHAT   Every organisation, member and invitation endpoint the product exposes.
 * WHY    These used to be Better Auth HTTP endpoints mounted at /api/auth with no gate on
 *        them at all. A line here is a line the block guards; a line there was not.
 */
import { createTRPCRouter } from "../init";
import { gatewayMutation, gatewayQuery } from "../procedures";

export const organizationRouter = createTRPCRouter({
  current: gatewayQuery("organization", "read"),
  create: gatewayMutation("organization", "create"),
  update: gatewayMutation("organization", "update"),
  remove: gatewayMutation("organization", "delete"),
  leave: gatewayMutation("membership", "delete"),
});

export const memberRouter = createTRPCRouter({
  list: gatewayQuery("member", "read"),
  invite: gatewayMutation("member", "create"),
  setRole: gatewayMutation("member", "update"),
  remove: gatewayMutation("member", "delete"),
});

export const invitationRouter = createTRPCRouter({
  list: gatewayQuery("invitation", "read"),
  revoke: gatewayMutation("invitation", "delete"),
});
