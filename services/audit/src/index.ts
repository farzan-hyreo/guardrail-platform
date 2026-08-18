/**
 * SOT: audit-service-entry, event-consumer, evt-consumer
 * WHAT   Serves rpc.auditLog.read, and consumes every evt.> to build the trail.
 * WHY    One durable consumer on `evt.>` means every audited mutation in the platform is
 *        recorded without a single service remembering to record it.
 * HOW    The consumer is built with `defineConsumer`, which verifies the envelope signature
 *        before the handler runs. Shape alone is not enough here: `audit_log.requestId` is
 *        unique and the insert ignores conflicts, so a forged event carrying a real request
 *        id would silently take the genuine record's place.
 * WHERE  packages/guardrail/src/service.ts, services/audit/src/audit.service.ts
 */
import "server-only";

import { env } from "@guardrail/env";
import { defineConsumer, defineService, handlerFor } from "@guardrail/guardrail";
import { queueGroup } from "@guardrail/registry";
import { closeConnection, consume, serveRpc } from "@guardrail/transport";

import { auditService } from "./audit.service";

const secret = env.envelopeSecret();

const runtime = defineService(
  "audit",
  [
    handlerFor("auditLog", "read", async ({ ctx, input }) =>
      auditService.list({
        organizationId: ctx.orgId,
        limit: input.limit,
        ...(input.resource === undefined ? {} : { resource: input.resource }),
      }),
    ),
  ],
  { secret },
);

async function main() {
  for (const route of runtime.routes) {
    await serveRpc({
      subject: route.subject,
      queue: queueGroup("audit"),
      handler: (raw, subject) => runtime.handle(raw, subject),
      unreadable: runtime.unreadable,
    });
    console.info(`[audit] serving ${route.subject}`);
  }

  // The trail. Every audited mutation in the platform lands here.
  void consume({
    stream: "EVT",
    durable: "audit-trail",
    filterSubject: "evt.>",
    handler: defineConsumer({ secret }, async ({ meta, payload }) => {
      await auditService.record({
        organizationId: meta.orgId,
        actorId: meta.userId,
        actorRole: meta.role,
        resource: meta.resource,
        operation: meta.operation,
        outcome: payload.outcome,
        requestId: meta.requestId,
      });
    }),
  });
  console.info("[audit] consuming evt.>");
}

main().catch((error) => {
  console.error("[audit] failed to start", error);
  process.exit(1);
});

process.on("SIGINT", () => void closeConnection().then(() => process.exit(0)));
process.on("SIGTERM", () => void closeConnection().then(() => process.exit(0)));
