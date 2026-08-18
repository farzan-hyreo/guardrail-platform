/**
 * SOT: member-contract, invitation-contract, identity-wire
 * WHERE services/identity
 */
import { z } from "zod";

import { ORG_ROLES } from "@guardrail/registry";

export const memberDto = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(ORG_ROLES),
  createdAt: z.date(),
});

export const memberContract = {
  read: { input: z.object({}), output: z.object({ items: z.array(memberDto) }) },
  /**
   * A command, not an rpc: sending an invitation involves an email provider that can be
   * slow or down. The gateway accepts it durably and answers immediately.
   */
  create: {
    input: z.object({ email: z.string().email(), role: z.enum(ORG_ROLES) }),
    output: z.object({ accepted: z.literal(true), requestId: z.string() }),
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
          expiresAt: z.date(),
        }),
      ),
    }),
  },
  delete: { input: z.object({ id: z.string() }), output: z.object({ id: z.string() }) },
} as const;
