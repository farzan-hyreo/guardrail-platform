/**
 * SOT: audit-table, audit-log-schema, audit-service-schema
 * WHAT   The compliance record. Written only by this service, from consumed events.
 * WHY    Audit is downstream of the request, not inside it. A slow write here can never
 *        slow a customer, and a service that forgets to audit is impossible: it does not
 *        write the audit log at all, it just succeeds and the event does the rest.
 */
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    actorId: text("actor_id").notNull(),
    actorRole: text("actor_role").notNull(),
    resource: text("resource").notNull(),
    operation: text("operation").notNull(),
    outcome: text("outcome").notNull(),
    requestId: text("request_id").notNull().unique(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("audit_org_created_idx").on(table.organizationId, table.createdAt)],
);
