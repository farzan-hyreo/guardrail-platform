/**
 * SOT: app-router, gateway-routers, api-surface
 * WHAT   The entire public API in one screen.
 * WHY    If a router is not here it does not exist. Auditing the API surface is reading
 *        this file, and every line in it is provably guarded.
 */
import { createCallerFactory, createTRPCRouter } from "../init";
import { auditRouter, billingRouter } from "./billing.router";
import { invitationRouter, memberRouter } from "./identity.router";
import { projectRouter } from "./project.router";

export const appRouter = createTRPCRouter({
  project: projectRouter,
  member: memberRouter,
  invitation: invitationRouter,
  billing: billingRouter,
  audit: auditRouter,
});

export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
