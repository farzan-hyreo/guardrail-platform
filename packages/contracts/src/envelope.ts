/**
 * SOT: envelope, request-meta, signing, wire-context, cross-service-context, trust-boundary
 * WHAT   The context object, serialised for the wire and signed.
 * WHY    In a single process `ctx` was trustworthy because only our code could construct
 *        it. On a bus, anything with credentials can publish. The envelope carries the
 *        gateway's authorisation decision and an HMAC over it, so a service can prove the
 *        org id it is about to query was authorised - not merely asserted.
 * HOW    Gateway signs after its checks pass. Service verifies before the handler runs.
 *        A service that skips verification cannot compile: defineService does it for you.
 * WHERE  @guardrail/guardrail (gateway + service), @guardrail/transport
 */
import { z } from "zod";

import {
  ORG_ROLES,
  isOperation,
  isPlanKey,
  isResourceKey,
  type Operation,
  type PlanKey,
  type ResourceKey,
} from "@guardrail/registry";

export const requestMeta = z.object({
  /** Follows the request across every hop. The audit trail is keyed on it. */
  requestId: z.string().min(8),
  /** Authorised by the gateway. Services scope every query to this and never to input. */
  orgId: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(ORG_ROLES),
  /** Permissions already checked at the gateway; carried so services can re-assert. */
  permissions: z.array(z.string()),
  plan: z.custom<PlanKey>(isPlanKey),
  /**
   * Validated against the registry rather than typed as `string`, so a service narrows
   * these by parsing instead of by asserting. This is what removes the last casts from
   * the service half of the block.
   */
  resource: z.custom<ResourceKey>(isResourceKey),
  operation: z.custom<Operation>(isOperation),
  /** Epoch ms. A service must refuse work nobody is waiting for any more. */
  deadlineAt: z.number().int(),
  issuedAt: z.number().int(),
  /** W3C traceparent, so one trace spans gateway, bus and service. */
  traceparent: z.string().optional(),
});

export type RequestMeta = z.infer<typeof requestMeta>;

export const envelope = z.object({
  meta: requestMeta,
  payload: z.unknown(),
  signature: z.string().min(16),
});

export type Envelope<TPayload = unknown> = {
  readonly meta: RequestMeta;
  readonly payload: TPayload;
  readonly signature: string;
};

export type ParsedEnvelope = z.infer<typeof envelope>;

export const replyEnvelope = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), requestId: z.string(), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    requestId: z.string(),
    error: z.object({
      code: z.string(),
      message: z.string(),
      data: z.unknown().optional(),
    }),
  }),
]);

export type ReplyEnvelope<TData = unknown> =
  | { ok: true; requestId: string; data: TData }
  | { ok: false; requestId: string; error: { code: string; message: string; data?: unknown } };

/** Stable stringification so both sides hash identical bytes. */
export function canonicalMeta(meta: RequestMeta): string {
  return JSON.stringify([
    meta.requestId,
    meta.orgId,
    meta.userId,
    meta.role,
    [...meta.permissions].sort(),
    meta.plan,
    meta.resource,
    meta.operation,
    meta.deadlineAt,
    meta.issuedAt,
  ]);
}

export function isExpired(meta: RequestMeta, now = Date.now()): boolean {
  return meta.deadlineAt <= now;
}
