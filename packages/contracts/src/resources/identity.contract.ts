/**
 * SOT: member-contract, invitation-contract, identity-wire
 * WHAT   Input and output schemas for every member and invitation operation.
 * WHY    Gateway and service parse the same schema, so neither can drift from the other.
 * HOW    member.create answers `{accepted: true}` rather than the invitation: it is a
 *        command, and nothing has happened yet when the gateway replies.
 * WHERE  services/identity
 */

import { ORG_ROLES } from "@guardrail/registry";
import { z } from "zod";

import { wireDate } from "../wire";

export const memberDto = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(ORG_ROLES),
  createdAt: wireDate,
});

export const memberContract = {
  read: { input: z.object({}), output: z.object({ items: z.array(memberDto) }) },
  /**
   * A command, not an rpc: sending an invitation involves an email provider that can be
   * slow or down. The gateway accepts it durably and answers immediately.
   *
   * `role` is every declared role on purpose, and this enum is NOT what stops an admin
   * minting an owner. A schema cannot see who is calling, so it cannot express "not above
   * your own"; narrowing it would instead break an owner legitimately granting owner. The
   * enum's job is the shape - a role that no organisation declares is refused here. The
   * rule is enforced where the caller is known: gateway gate 4b and service gate 5b, both
   * derived from `assignableRoles`, and both running before this schema is ever parsed.
   */
  create: {
    input: z.object({ email: z.string().email(), role: z.enum(ORG_ROLES) }),
    output: z.object({ accepted: z.literal(true), requestId: z.string() }),
  },
  /**
   * Changing a role. The registry gates this at owner; the service refuses a role above the
   * caller's own as well, so the two agree instead of one trusting the other.
   */
  update: {
    input: z.object({ memberId: z.string(), role: z.enum(ORG_ROLES) }),
    output: memberDto,
  },
  delete: { input: z.object({ memberId: z.string() }), output: z.object({ id: z.string() }) },
} as const;

export const invitationContract = {
  read: {
    input: z.object({}),
    output: z.object({
      items: z.array(
        z.object({
          id: z.string(),
          email: z.string(),
          role: z.string().nullable(),
          status: z.string(),
          expiresAt: wireDate,
        }),
      ),
    }),
  },
  delete: { input: z.object({ id: z.string() }), output: z.object({ id: z.string() }) },
} as const;
