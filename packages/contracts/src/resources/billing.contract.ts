/**
 * SOT: billing-contract, entitlements-wire, checkout-contract
 * WHAT   Input and output schemas for entitlements and checkout.
 * WHY    Gateway and service parse the same schema, so neither can drift from the other.
 * HOW    Plans come from PLAN_KEYS, so a plan added to the registry is accepted here
 *        without anybody editing this file.
 * WHERE  services/billing
 */

import { PLAN_KEYS } from "@guardrail/registry";
import { z } from "zod";

export const entitlementsDto = z.object({
  plan: z.enum(PLAN_KEYS),
  usage: z.record(z.string(), z.number()),
});

export const billingContract = {
  read: {
    input: z.object({}),
    output: z.object({
      entitlements: entitlementsDto,
      resources: z.array(z.object({ resource: z.string(), label: z.string(), usage: z.string() })),
    }),
  },
  manage: {
    input: z.object({ plan: z.enum(PLAN_KEYS), successUrl: z.string().url() }),
    output: z.object({ url: z.string().nullable() }),
  },
} as const;
