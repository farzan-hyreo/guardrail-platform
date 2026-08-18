/**
 * SOT: gateway-deps, entitlements-cache, gateway-wiring, cache-invalidation
 * WHAT   The three functions the gateway block needs, wired to real providers.
 * WHY    The block takes its dependencies as arguments so it stays testable and so a
 *        vendor swap touches one file. This is that file.
 * HOW    Entitlements are cached for 30s and invalidated by evt.billing.manage, because
 *        asking the billing service on every request would put a network hop in front of
 *        every read in the product.
 * WHERE  apps/web/src/gateway/procedures.ts
 */
import "server-only";

import { identify } from "@guardrail/auth";
import type { ReplyEnvelope } from "@guardrail/contracts";
import { env } from "@guardrail/env";
import type { GatewayDeps } from "@guardrail/guardrail";
import { EMPTY_ENTITLEMENTS, type Entitlements, rpcSubject } from "@guardrail/registry";
import { rpcRequest } from "@guardrail/transport";
import { signedEnvelopeFor } from "./internal-envelope";
import { rateLimit } from "./ratelimit";

const TTL_MS = 30_000;
const cache = new Map<string, { value: Entitlements; expiresAt: number }>();

export function invalidateEntitlements(orgId: string): void {
  cache.delete(orgId);
}

async function entitlements(orgId: string): Promise<Entitlements> {
  const hit = cache.get(orgId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  try {
    const reply = await rpcRequest<{ entitlements: Entitlements }>({
      subject: rpcSubject("billing", "read"),
      envelope: signedEnvelopeFor({ orgId, resource: "billing", operation: "read" }),
      timeoutMs: 4000,
    });

    if (reply.ok && reply.data?.entitlements) {
      const value = reply.data.entitlements;
      cache.set(orgId, { value, expiresAt: Date.now() + TTL_MS });
      return value;
    }

    // Billing answered but refused or returned nothing usable. Log the reason so this
    // is visible, but do not cache the degradation - a transient failure must last one
    // request, not thirty seconds, or a paying org gets refused at the plan gate while
    // billing is perfectly healthy.
    console.error(
      `[entitlements] billing did not return usable data for org ${orgId}: ${
        reply.ok ? "empty response" : reply.error.code
      }`,
    );
    return EMPTY_ENTITLEMENTS;
  } catch (error) {
    // Billing being unreachable must not lock paying customers out either. Degrade, do
    // not deny - and do not cache, for the same reason as above.
    console.error(`[entitlements] billing unreachable for org ${orgId}`, error);
    return EMPTY_ENTITLEMENTS;
  }
}

export const gatewayDeps: GatewayDeps = {
  identify,
  entitlements,
  rateLimit: (args) => rateLimit(args),
  secret: env.envelopeSecret(),
};

export type { ReplyEnvelope };
