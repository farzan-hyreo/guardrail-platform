/**
 * SOT: audit-service, audit-write, audit-queries, idempotent-write
 * WHY    Consumers are at-least-once, so the same event can arrive twice. requestId is
 *        unique and the insert ignores conflicts: replay is harmless by construction.
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
