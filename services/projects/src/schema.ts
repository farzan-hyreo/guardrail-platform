/**
 * SOT: project-table, projects-schema, project-service-schema
 * WHAT   Tables the projects service owns. No other service may read or migrate them.
 * WHY    Service isolation is a data boundary before it is a code boundary. There is no
 *        shared schema package to import, so a cross-service query cannot be written.
 * NOTE   organization_id is a plain column, not a foreign key: the organisation lives in
 *        the identity service's schema. Referential integrity across services is enforced
 *        by events (evt.organization.deleted), not by the database.
 * WHERE  services/projects/src/project.service.ts
 */
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const project = pgTable(
  "project",
  {
    id: text("id").primaryKey(),
    /** Every tenant-owned row carries the org id. No org id, no row. */
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    createdById: text("created_by_id").notNull(),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("project_org_slug_idx").on(table.organizationId, table.slug),
    index("project_org_created_idx").on(table.organizationId, table.createdAt),
  ],
);

export type ProjectRow = typeof project.$inferSelect;
