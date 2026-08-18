/**
 * SOT: internal-envelope, system-envelope, gateway-internal-call
 * WHAT   Builds a signed envelope for calls the gateway makes on its own behalf.
 * WHY    Fetching entitlements happens before a user's own authorisation is complete, so
 *        it cannot reuse that request's envelope. It gets a narrow system envelope instead
 *        - one permission, short deadline - rather than an unsigned back door.
 * WHERE  apps/web/src/gateway/deps.ts
 */
import "server-only";

import { env } from "@guardrail/env";
import { signMeta, type Envelope, type RequestMeta } from "@guardrail/contracts";
import { toPermission, type OperationOf, type ResourceKey } from "@guardrail/registry";

export function signedEnvelopeFor<K extends ResourceKey, O extends OperationOf<K>>(args: {
  orgId: string;
  resource: K;
  operation: O;
}): Envelope {
  const meta: RequestMeta = {
    requestId: crypto.randomUUID(),
    orgId: args.orgId,
    userId: "system:gateway",
    role: "owner",
    permissions: [toPermission(args.resource, args.operation)],
    plan: "unknown",
    resource: args.resource,
    operation: String(args.operation),
    issuedAt: Date.now(),
    deadlineAt: Date.now() + 4000,
  };
  return { meta, payload: {}, signature: signMeta(meta, env.envelopeSecret()) };
}
