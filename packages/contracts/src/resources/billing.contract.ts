/**
 * SOT: billing-contract, entitlements-wire, checkout-contract
 * WHAT   Input and output schemas for entitlements and checkout.
 * WHY    Gateway and service parse the same schema, so neither can drift from the other.
 * HOW    Plans come from PLAN_KEYS, so a plan added to the registry is accepted here
 *        without anybody editing this file.
 * WHERE  services/billing
 */

import { isResourceKey, PLAN_KEYS, type ResourceKey } from "@guardrail/registry";
import { z } from "zod";

export const entitlementsDto = z.object({
  plan: z.enum(PLAN_KEYS),
  /** Keyed by ResourceKey, like the registry's own Entitlements - the wire must not widen
   *  what the registry narrowed. `partialRecord`, not `record`: a resource with no usage
   *  yet has no key, exactly as `Entitlements.usage` is `Partial<Record<...>>`. */
  usage: z.partialRecord(z.custom<ResourceKey>(isResourceKey), z.number()),
});

export const billingContract = {
  read: {
    input: z.object({}),
    output: z.object({
      entitlements: entitlementsDto,
      /**
       * `resource` is validated against the registry rather than typed as `string`, so the
       * billing page can hand each row straight to <UsageMeter resource=…/> without a cast.
       * Same pattern as `requestMeta.resource` in envelope.ts.
       */
      resources: z.array(
        z.object({
          resource: z.custom<ResourceKey>(isResourceKey),
          label: z.string(),
          usage: z.string(),
        }),
      ),
    }),
  },
  manage: {
    input: z.object({ plan: z.enum(PLAN_KEYS), successUrl: z.string().url() }),
    output: z.object({ url: z.string().nullable() }),
  },
} as const;
