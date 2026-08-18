/**
 * SOT: identity-service-entry, seats, invitations, command-handler
 * WHAT   Serves team reads and invitation writes.
 * WHY    member.create is declared a `command` in the registry, not an rpc: sending an
 *        invitation involves an email provider that can be slow or down. The gateway
 *        accepts it durably and answers immediately; this service retries until it sticks.
 * HOW    Every delivery hands the runtime the subject it arrived on, so a signed rpc
 *        envelope cannot be replayed onto the CMD stream and become durable. The command's
 *        8s budget is not a deadline here - the stream's max age is what expires it.
 * WHERE  packages/guardrail/src/service.ts, services/identity/src/identity.service.ts
 */
import "server-only";

import { type OutputOf, ServiceError } from "@guardrail/contracts";
import { env } from "@guardrail/env";
import { defineService, handlerFor } from "@guardrail/guardrail";
import { HIGHEST_ROLE, normalizeRole, queueGroup, roleAtLeast } from "@guardrail/registry";
import { closeConnection, consume, serveRpc } from "@guardrail/transport";

import { identityService } from "./identity.service";

const secret = env.envelopeSecret();

/**
 * An organisation whose last owner leaves or is demoted is a tenant nobody can administer -
 * no invitations, no billing, no way back without a database. Two operations can cause it,
 * so the rule lives in one function rather than in each of them.
 */
async function assertNotTheLastOwner(organizationId: string): Promise<void> {
  const owners = (await identityService.members(organizationId)).filter(
    (row) => normalizeRole(row.role) === HIGHEST_ROLE,
  );
  if (owners.length <= 1) {
    throw new ServiceError(
      "CONFLICT",
      "This organisation would be left without an owner. Promote somebody else first.",
    );
  }
}

const runtime = defineService(
  "identity",
  [
    handlerFor("member", "read", async ({ ctx }) => ({
      // The column is a plain text role. `normalizeRole` degrades an unrecognised one down
      // to member rather than asserting it into the union the contract promises.
      items: (await identityService.members(ctx.orgId)).map((row) => ({
        ...row,
        role: normalizeRole(row.role),
      })),
    })),

    handlerFor("member", "create", async ({ ctx, input }) => {
      // Derived from the contract, so `accepted` stays the literal the schema declares
      // instead of widening to boolean across the two returns below.
      const accepted: OutputOf<"member", "create"> = {
        accepted: true,
        requestId: ctx.requestId,
      };
      // Idempotent: a redelivered command must not send a second invitation.
      const existing = await identityService.invitations(ctx.orgId);
      if (existing.some((row) => row.email === input.email)) {
        return accepted;
      }
      const created = await identityService.createInvitation({
        organizationId: ctx.orgId,
        email: input.email,
        role: input.role,
        inviterId: ctx.userId,
      });
      if (created === null) throw new ServiceError("INTERNAL", "The invitation was not created.");
      // Delivery is a separate concern: a notifier consumes evt.member.create.
      return accepted;
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

    /**
     * Changing a role. The registry already refused anyone below owner, so what is left to
     * check is the one thing a gate cannot see: the role being *granted*. Without this an
     * owner-gated endpoint is still an endpoint that can hand out `owner`, and the review
     * found exactly that shape one level up, where an admin could mint one.
     */
    handlerFor("member", "update", async ({ ctx, input }) => {
      if (!roleAtLeast(ctx.role, input.role)) {
        throw new ServiceError("PERMISSION_DENIED", "You cannot grant a role above your own.");
      }
      const target = await identityService.memberIn({
        organizationId: ctx.orgId,
        memberId: input.memberId,
      });
      if (target === null) {
        throw new ServiceError("NOT_FOUND", "That person is not in this organisation.");
      }
      // Demoting the last owner leaves an organisation nobody can administer.
      if (normalizeRole(target.role) === HIGHEST_ROLE && input.role !== HIGHEST_ROLE) {
        await assertNotTheLastOwner(ctx.orgId);
      }
      const updated = await identityService.setMemberRole({
        organizationId: ctx.orgId,
        memberId: input.memberId,
        role: input.role,
      });
      if (updated === null) throw new ServiceError("INTERNAL", "The role was not changed.");
      return { ...updated, role: normalizeRole(updated.role) };
    }),

    handlerFor("organization", "read", async ({ ctx }) => {
      const found = await identityService.organizationWithCount(ctx.orgId);
      if (found === null) throw new ServiceError("NOT_FOUND", "Organisation not found.");
      return found;
    }),

    /**
     * A *second* organisation. The first one is created at signup, server-side, so this is
     * never the path a brand new user takes and cannot be looped to mint tenants: the
     * registry gates it at owner and counts it against the plan before the bus is touched.
     */
    handlerFor("organization", "create", async ({ ctx, input }) => {
      if (await identityService.slugTaken(input.slug)) {
        throw new ServiceError("CONFLICT", `The slug '${input.slug}' is already taken.`);
      }
      const created = await identityService.createOrganization({
        name: input.name,
        slug: input.slug,
        ownerId: ctx.userId,
        ownerRole: HIGHEST_ROLE,
      });
      if (created === null) throw new ServiceError("INTERNAL", "The organisation was not created.");
      return created;
    }),

    handlerFor("organization", "update", async ({ ctx, input }) => {
      if (input.slug !== undefined && (await identityService.slugTaken(input.slug))) {
        throw new ServiceError("CONFLICT", `The slug '${input.slug}' is already taken.`);
      }
      // exactOptionalPropertyTypes: keys are added, never set to undefined.
      const values = {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.slug === undefined ? {} : { slug: input.slug }),
      };
      const updated = await identityService.updateOrganization({
        organizationId: ctx.orgId,
        values,
      });
      if (updated === null) throw new ServiceError("NOT_FOUND", "Organisation not found.");
      return updated;
    }),

    handlerFor("organization", "delete", async ({ ctx }) => {
      const removed = await identityService.deleteOrganization(ctx.orgId);
      if (removed === null) throw new ServiceError("NOT_FOUND", "Organisation not found.");
      return removed;
    }),

    /**
     * Leaving. There is no id in the input and none in this function: the row is found by
     * ctx.orgId and ctx.userId, both from the signed envelope, so no shape of this request
     * removes anybody else.
     */
    handlerFor("membership", "delete", async ({ ctx }) => {
      const own = await identityService.membershipOf({
        organizationId: ctx.orgId,
        userId: ctx.userId,
      });
      if (own === null) throw new ServiceError("NOT_FOUND", "You are not in this organisation.");
      if (normalizeRole(own.role) === HIGHEST_ROLE) await assertNotTheLastOwner(ctx.orgId);
      const removed = await identityService.removeMember({
        organizationId: ctx.orgId,
        memberId: own.id,
      });
      if (removed === null) throw new ServiceError("INTERNAL", "You were not removed.");
      return removed;
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
        handler: (raw, subject) => runtime.handle(raw, subject),
        unreadable: runtime.unreadable,
      });
    } else {
      void consume({
        stream: "CMD",
        durable: `identity-${route.resource}-${route.operation}`,
        filterSubject: route.subject,
        handler: async (raw, subject) => {
          const reply = await runtime.handle(raw, subject);
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
