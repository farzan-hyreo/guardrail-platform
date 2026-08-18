/**
 * SOT: audit-contract, audit-wire
 * WHERE services/audit
 */
import { z } from "zod";

export const auditContract = {
  read: {
    input: z.object({
      limit: z.number().int().min(1).max(200).default(50),
      resource: z.string().optional(),
    }),
    output: z.object({
      items: z.array(
        z.object({
          id: z.string(),
          resource: z.string(),
          operation: z.string(),
          actorId: z.string(),
          actorRole: z.string(),
          outcome: z.string(),
          createdAt: z.date(),
        }),
      ),
    }),
  },
} as const;
