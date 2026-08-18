/**
 * SOT: project-service, project-queries, project-database
 * WHAT   The only code that reads or writes the project table.
 * WHY    Database isolation inside the service too: handlers hold business rules, this
 *        holds storage. Every signature takes organizationId first, so there is no
 *        function here capable of a cross-tenant query.
 * HOW    organizationId always comes from ctx.orgId, which comes from the signed envelope.
 * WHERE  services/projects/src/project.handlers.ts
 */
import "server-only";

import { and, count, desc, eq, isNull, lt } from "drizzle-orm";

import { db } from "./db";
import { project } from "./schema";

export const projectService = {
  async list(args: {
    organizationId: string;
    limit: number;
    cursor?: string | null;
    includeArchived: boolean;
  }) {
    const filters = [eq(project.organizationId, args.organizationId)];
    if (!args.includeArchived) filters.push(isNull(project.archivedAt));
    if (args.cursor) filters.push(lt(project.createdAt, new Date(args.cursor)));

    const rows = await db
      .select()
      .from(project)
      .where(and(...filters))
      .orderBy(desc(project.createdAt))
      .limit(args.limit + 1);

    const hasMore = rows.length > args.limit;
    const items = hasMore ? rows.slice(0, args.limit) : rows;
    return { items, nextCursor: hasMore ? (items.at(-1)?.createdAt.toISOString() ?? null) : null };
  },

  async bySlug(args: { organizationId: string; slug: string }) {
    const [row] = await db
      .select()
      .from(project)
      .where(and(eq(project.organizationId, args.organizationId), eq(project.slug, args.slug)))
      .limit(1);
    return row ?? null;
  },

  async countActive(organizationId: string) {
    const [row] = await db
      .select({ value: count() })
      .from(project)
      .where(and(eq(project.organizationId, organizationId), isNull(project.archivedAt)));
    return row?.value ?? 0;
  },

  async create(args: {
    organizationId: string;
    createdById: string;
    name: string;
    slug: string;
    description?: string;
  }) {
    const [row] = await db
      .insert(project)
      .values({
        id: crypto.randomUUID(),
        organizationId: args.organizationId,
        createdById: args.createdById,
        name: args.name,
        slug: args.slug,
        description: args.description ?? null,
      })
      .returning();
    return row;
  },

  async update(args: {
    organizationId: string;
    id: string;
    name?: string;
    description?: string | null;
    archived?: boolean;
  }) {
    const [row] = await db
      .update(project)
      .set({
        name: args.name,
        description: args.description,
        archivedAt: args.archived === undefined ? undefined : args.archived ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(project.organizationId, args.organizationId), eq(project.id, args.id)))
      .returning();
    return row ?? null;
  },

  async remove(args: { organizationId: string; id: string }) {
    const [row] = await db
      .delete(project)
      .where(and(eq(project.organizationId, args.organizationId), eq(project.id, args.id)))
      .returning({ id: project.id });
    return row ?? null;
  },
};
