/**
 * SOT: project-handlers, project-business-logic
 * WHAT   Business logic for projects. Nothing else.
 * WHY    Auth, plan limits, rate limits, audit and metering already happened at the gateway
 *        and are enforced by defineService. What is left is what the product actually means
 *        by "create a project", which is the only part worth thinking about.
 * HOW    `handlerFor` infers input and output from the contract - never annotate them.
 *        ctx.orgId comes from the signed envelope; never scope a query to anything else.
 * WHERE  packages/guardrail/src/service.ts, services/projects/src/project.service.ts
 */
import "server-only";

import { ServiceError } from "@guardrail/contracts";
import { handlerFor } from "@guardrail/guardrail";

import { projectService } from "./project.service";

export const projectHandlers = [
  handlerFor("project", "read", async ({ ctx, input }) =>
    projectService.list({
      organizationId: ctx.orgId,
      limit: input.limit,
      cursor: input.cursor ?? null,
      includeArchived: input.includeArchived,
    }),
  ),

  handlerFor("project", "create", async ({ ctx, input }) => {
    // Business rule. The plan limit was already refused at the gateway.
    const clash = await projectService.bySlug({ organizationId: ctx.orgId, slug: input.slug });
    if (clash !== null) {
      throw new ServiceError("CONFLICT", "That slug is taken in this organisation.");
    }
    const created = await projectService.create({
      organizationId: ctx.orgId,
      createdById: ctx.userId,
      name: input.name,
      slug: input.slug,
      // exactOptionalPropertyTypes: "absent" and "present but undefined" are different
      // states, so the key is built conditionally rather than passed as undefined.
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    if (created === undefined) throw new ServiceError("INTERNAL", "The project was not created.");
    return created;
  }),

  handlerFor("project", "update", async ({ ctx, input }) => {
    const updated = await projectService.update({
      organizationId: ctx.orgId,
      id: input.id,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.archived === undefined ? {} : { archived: input.archived }),
    });
    if (updated === null) throw new ServiceError("NOT_FOUND", "Project not found.");
    return updated;
  }),

  handlerFor("project", "delete", async ({ ctx, input }) => {
    const removed = await projectService.remove({ organizationId: ctx.orgId, id: input.id });
    if (removed === null) throw new ServiceError("NOT_FOUND", "Project not found.");
    return removed;
  }),
];
