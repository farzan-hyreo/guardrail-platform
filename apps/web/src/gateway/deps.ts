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
import { env } from "@guardrail/env";
import type { GatewayDeps } from "@guardrail/guardrail";
import { DEFAULT_PLAN, type Entitlements } from "@guardrail/registry";
import { rpcSubject, type ReplyEnvelope } from "@guardrail/contracts";
import { rpcRequest } from "@guardrail/transport";

import { rateLimit } from "./ratelimit";
import { signedEnvelopeFor } from "./internal-envelope";

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
    const value =
      reply.ok && reply.data?.entitlements
        ? reply.data.entitlements
        : { plan: DEFAULT_PLAN, usage: {} };
    cache.set(orgId, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  } catch {
    // Billing being down must not lock paying customers out. Degrade, do not deny.
    return { plan: DEFAULT_PLAN, usage: {} };
  }
}

export const gatewayDeps: GatewayDeps = {
  identify,
  entitlements,
  rateLimit: (args) => rateLimit(args),
  secret: env.envelopeSecret(),
};

export type { ReplyEnvelope };
