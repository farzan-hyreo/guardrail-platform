/**
 * SOT: audit-service, audit-write, audit-queries, idempotent-write
 * WHAT   The only code that reads or writes the audit_log table.
 * WHY    Consumers are at-least-once, so the same event can arrive twice. requestId is
 *        unique and the insert ignores conflicts: replay is harmless by construction.
 *        That same uniqueness is why the consumer must verify the envelope signature: a
 *        forged event carrying a real request id would take the genuine row's place.
 * HOW    Every query is scoped to organizationId, which comes from the signed envelope.
 * WHERE  services/audit/src/index.ts
 */
import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { db } from "./db";
import { auditLog } from "./schema";

export const auditService = {
  async record(entry: {
    organizationId: string;
    actorId: string;
    actorRole: string;
    resource: string;
    operation: string;
    outcome: string;
    requestId: string;
    metadata?: Record<string, unknown>;
  }) {
    await db
      .insert(auditLog)
      .values({ id: crypto.randomUUID(), ...entry, metadata: entry.metadata ?? null })
      .onConflictDoNothing({ target: auditLog.requestId });
  },

  async list(args: { organizationId: string; limit: number; resource?: string }) {
    const where = args.resource
      ? and(eq(auditLog.organizationId, args.organizationId), eq(auditLog.resource, args.resource))
      : eq(auditLog.organizationId, args.organizationId);

    const items = await db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt))
      .limit(args.limit);
    return { items };
  },
};
