/**
 * SOT: billing-service-entry, entitlements-service, checkout-service, metering-consumer
 * WHAT   Serves entitlements and checkout, and meters usage from the event stream.
 * WHY    Autumn is this service's database, so it owns no tables. Metering is driven by
 *        evt.> rather than by each service remembering to call track() - the same reason
 *        audit is a consumer.
 */
import "server-only";

import { envelope as envelopeSchema } from "@guardrail/contracts";
import { billing } from "@guardrail/billing";
import { defineService, handlerFor } from "@guardrail/guardrail";
import {
  RESOURCES,
  RESOURCE_KEYS,
  isOperationOf,
  queueGroup,
  ruleFor,
  usageLabel,
} from "@guardrail/registry";
import { env } from "@guardrail/env";
import { closeConnection, consume, serveRpc } from "@guardrail/transport";

const secret = env.envelopeSecret();

const runtime = defineService(
  "billing",
  [
    handlerFor("billing", "read", async ({ ctx }) => {
      const entitlements = await billing.getEntitlements(ctx.orgId);
      return {
        entitlements,
        resources: RESOURCE_KEYS.map((resource) => ({
          resource,
          label: RESOURCES[resource].label,
          usage: usageLabel(resource, entitlements),
        })),
      };
    }),

    handlerFor("billing", "manage", async ({ ctx, input }) =>
      billing.checkout({
        organizationId: ctx.orgId,
        plan: input.plan,
        successUrl: input.successUrl,
      }),
    ),
  ],
  { secret },
);

async function main() {
  for (const route of runtime.routes) {
    await serveRpc({
      subject: route.subject,
      queue: queueGroup("billing"),
      handler: (raw) => runtime.handle(raw),
    });
    console.info(`[billing] serving ${route.subject}`);
  }

  // Metering. Anything the registry marks `consumes` is counted when it actually happened.
  void consume({
    stream: "EVT",
    durable: "billing-meter",
    filterSubject: "evt.>",
    handler: async (raw) => {
      const parsed = envelopeSchema.safeParse(raw);
      if (!parsed.success) return;
      const { meta } = parsed.data;
      // meta.resource and meta.operation were narrowed by the envelope schema, so this
      // needs a guard rather than a cast.
      if (!isOperationOf(meta.resource, meta.operation)) return;
      if (!ruleFor(meta.resource, meta.operation).consumes) return;
      await billing.track({ organizationId: meta.orgId, resource: meta.resource, value: 1 });
    },
  });
  console.info("[billing] metering evt.>");
}

main().catch((error) => {
  console.error("[billing] failed to start", error);
  process.exit(1);
});

process.on("SIGINT", () => void closeConnection().then(() => process.exit(0)));
process.on("SIGTERM", () => void closeConnection().then(() => process.exit(0)));
