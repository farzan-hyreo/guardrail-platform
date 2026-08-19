/**
 * SOT: audit-contract, audit-wire
 * WHAT   Input and output schemas for reading the audit trail.
 * WHY    Gateway and service parse the same schema, so neither can drift from the other.
 * HOW    Read only. Rows are written by the evt.> consumer, never by a request.
 * WHERE  services/audit
 */
import { z } from "zod";

import { wireDate } from "../wire";

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
          createdAt: wireDate,
        }),
      ),
    }),
  },
} as const;
