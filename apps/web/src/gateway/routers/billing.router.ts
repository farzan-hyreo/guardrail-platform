/**
 * SOT: billing-gateway-router, checkout-route, audit-gateway-router
 */
import { createTRPCRouter } from "../init";
import { gatewayMutation, gatewayQuery } from "../procedures";

export const billingRouter = createTRPCRouter({
  overview: gatewayQuery("billing", "read"),
  checkout: gatewayMutation("billing", "manage"),
});

export const auditRouter = createTRPCRouter({
  list: gatewayQuery("auditLog", "read"),
});
