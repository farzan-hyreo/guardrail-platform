/**
 * SOT: internal-envelope, system-envelope, gateway-internal-call
 * WHAT   Builds a signed envelope for calls the gateway makes on its own behalf.
 * WHY    Fetching entitlements happens before a user's own authorisation is complete, so
 *        it cannot reuse that request's envelope. It gets a narrow system envelope instead
 *        - one permission, short deadline - rather than an unsigned back door.
 * HOW    Every field is the type `requestMeta` declares, never a stand-in string. A meta the
 *        service cannot parse is rejected as UNTRUSTED_ENVELOPE, the caller reads that as
 *        "billing is down" and caches the default plan for thirty seconds, and every paying
 *        organisation is silently pinned to the free plan while nothing is actually broken.
 * WHERE  apps/web/src/gateway/deps.ts
 */
import "server-only";

import { type Envelope, type RequestMeta, signRequest } from "@guardrail/contracts";
import { env } from "@guardrail/env";
import {
  DEFAULT_PLAN,
  type OperationOf,
  type ResourceKey,
  toPermission,
} from "@guardrail/registry";

/** Short by design: nobody retries a system call, and a wide deadline is a wide replay. */
const SYSTEM_TIMEOUT_MS = 4000;

export function signedEnvelopeFor<K extends ResourceKey, O extends OperationOf<K>>(args: {
  orgId: string;
  resource: K;
  operation: O;
}): Envelope {
  const issuedAt = Date.now();
  const meta: RequestMeta = {
    requestId: crypto.randomUUID(),
    orgId: args.orgId,
    userId: "system:gateway",
    role: "owner",
    permissions: [toPermission(args.resource, args.operation)],
    /** From the registry. "unknown" is not a plan, and a meta that fails to parse is a
     *  refused envelope, not a degraded one. */
    plan: DEFAULT_PLAN,
    resource: args.resource,
    /** Already narrowed to an Operation by OperationOf<K>; String() would widen it back. */
    operation: args.operation,
    issuedAt,
    deadlineAt: issuedAt + SYSTEM_TIMEOUT_MS,
  };
  const payload = {};
  return { meta, payload, signature: signRequest(meta, payload, env.envelopeSecret()) };
}
