/**
 * SOT: identity-service-entry, seats, invitations, command-handler
 * WHAT   Serves team reads and invitation writes.
 * WHY    member.create is declared a `command` in the registry, not an rpc: sending an
 *        invitation involves an email provider that can be slow or down. The gateway
 *        accepts it durably and answers immediately; this service retries until it sticks.
 */
import "server-only";

import { ServiceError } from "@guardrail/contracts";
import { defineService, handlerFor } from "@guardrail/guardrail";
import { queueGroup } from "@guardrail/registry";
import { env } from "@guardrail/env";
import { closeConnection, consume, serveRpc } from "@guardrail/transport";

import { identityService } from "./identity.service";

const secret = env.envelopeSecret();

const runtime = defineService(
  "identity",
  [
    handlerFor("member", "read", async ({ ctx }) => ({
      items: await identityService.members(ctx.orgId),
    })),

    handlerFor("member", "create", async ({ ctx, input }) => {
      // Idempotent: a redelivered command must not send a second invitation.
      const existing = await identityService.invitations(ctx.orgId);
      if (existing.some((row) => row.email === input.email)) {
        return { accepted: true, requestId: ctx.requestId };
      }
      const created = await identityService.createInvitation({
        organizationId: ctx.orgId,
        email: input.email,
        role: input.role,
        inviterId: ctx.userId,
      });
      if (created === null) throw new ServiceError("INTERNAL", "The invitation was not created.");
      // Delivery is a separate concern: a notifier consumes evt.member.create.
      return { accepted: true, requestId: ctx.requestId };
    }),

    handlerFor("member", "delete", async ({ ctx, input }) => {
      const removed = await identityService.removeMember({
        organizationId: ctx.orgId,
        memberId: input.memberId,
      });
      if (removed === null) {
        throw new ServiceError("NOT_FOUND", "That person is not in this organisation.");
      }
      return removed;
    }),

    handlerFor("invitation", "read", async ({ ctx }) => ({
      items: await identityService.invitations(ctx.orgId),
    })),

    handlerFor("invitation", "delete", async ({ ctx, input }) => {
      const revoked = await identityService.revokeInvitation({
        organizationId: ctx.orgId,
        id: input.id,
      });
      if (revoked === null) throw new ServiceError("NOT_FOUND", "Invitation not found.");
      return revoked;
    }),
  ],
  { secret },
);

async function main() {
  for (const route of runtime.routes) {
    if (route.transport === "rpc") {
      await serveRpc({
        subject: route.subject,
        queue: queueGroup("identity"),
        handler: (raw) => runtime.handle(raw),
      });
    } else {
      void consume({
        stream: "CMD",
        durable: `identity-${route.resource}-${route.operation}`,
        filterSubject: route.subject,
        handler: async (raw) => {
          const reply = await runtime.handle(raw);
          if (!reply.ok) throw new Error(reply.error.message);
        },
      });
    }
    console.info(`[identity] serving ${route.subject} (${route.transport})`);
  }
}

main().catch((error) => {
  console.error("[identity] failed to start", error);
  process.exit(1);
});

process.on("SIGINT", () => void closeConnection().then(() => process.exit(0)));
process.on("SIGTERM", () => void closeConnection().then(() => process.exit(0)));
