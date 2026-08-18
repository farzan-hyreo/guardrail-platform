/**
 * SOT: billing-contract, entitlements-wire, checkout-contract
 * WHERE services/billing
 */
import { z } from "zod";

import { PLAN_KEYS } from "@guardrail/registry";

export const entitlementsDto = z.object({
  plan: z.enum(PLAN_KEYS),
  usage: z.record(z.string(), z.number()),
});

export const billingContract = {
  read: {
    input: z.object({}),
    output: z.object({
      entitlements: entitlementsDto,
      resources: z.array(
        z.object({ resource: z.string(), label: z.string(), usage: z.string() }),
      ),
    }),
  },
  manage: {
    input: z.object({ plan: z.enum(PLAN_KEYS), successUrl: z.string().url() }),
    output: z.object({ url: z.string().nullable() }),
  },
} as const;
