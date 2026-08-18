/**
 * SOT: audit-service-entry, event-consumer, evt-consumer
 * WHAT   Serves rpc.auditLog.read, and consumes every evt.> to build the trail.
 * WHY    One durable consumer on `evt.>` means every audited mutation in the platform is
 *        recorded without a single service remembering to record it.
 */
import "server-only";

import { envelope as envelopeSchema } from "@guardrail/contracts";
import { defineService, handlerFor } from "@guardrail/guardrail";
import { queueGroup } from "@guardrail/registry";
import { env } from "@guardrail/env";
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
      handler: (raw) => runtime.handle(raw),
    });
    console.info(`[audit] serving ${route.subject}`);
  }

  // The trail. Every audited mutation in the platform lands here.
  void consume({
    stream: "EVT",
    durable: "audit-trail",
    filterSubject: "evt.>",
    handler: async (raw) => {
      const parsed = envelopeSchema.safeParse(raw);
      if (!parsed.success) return;
      const { meta, payload } = parsed.data;
      await auditService.record({
        organizationId: meta.orgId,
        actorId: meta.userId,
        actorRole: meta.role,
        resource: meta.resource,
        operation: meta.operation,
        outcome: (payload as { outcome?: string })?.outcome ?? "success",
        requestId: meta.requestId,
      });
    },
  });
  console.info("[audit] consuming evt.>");
}

main().catch((error) => {
  console.error("[audit] failed to start", error);
  process.exit(1);
});

process.on("SIGINT", () => void closeConnection().then(() => process.exit(0)));
process.on("SIGTERM", () => void closeConnection().then(() => process.exit(0)));
