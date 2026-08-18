/**
 * SOT: envelope, request-meta, signing, canonical-json, canonical-request, canonical-reply,
 *      freshness, clock-skew, wire-context, cross-service-context, trust-boundary
 * WHAT   The context object, serialised for the wire, plus the exact bytes that get signed.
 * WHY    In a single process `ctx` was trustworthy because only our code could construct
 *        it. On a bus, anything with credentials can publish. The envelope carries the
 *        gateway's authorisation decision and an HMAC over it, so a service can prove the
 *        org id it is about to query was authorised - not merely asserted. The MAC covers
 *        the payload too: an envelope is `{meta, payload, signature}`, so a MAC over the
 *        meta alone lets anyone on the bus keep a captured signature and swap the body.
 * HOW    Gateway signs after its checks pass. Service verifies before the handler runs.
 *        `canonicalRequest` is locked with `satisfies` against `keyof RequestMeta`, so a
 *        field added to `requestMeta` and not to the canonical form is a compile error
 *        rather than a field that quietly moved to the unsigned side of the boundary.
 * WHERE  @guardrail/guardrail (gateway + service), @guardrail/transport
 */
import { createHash } from "node:crypto";
import {
  isOperation,
  isPlanKey,
  isResourceKey,
  MAX_TIMEOUT_MS,
  type Operation,
  type OperationRule,
  ORG_ROLES,
  type PlanKey,
  type ResourceKey,
} from "@guardrail/registry";
import { z } from "zod";

import type { ErrorCode } from "./errors";

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

/**
 * A reply carries a MAC of its own. A queue group is not exclusivity: anything subscribed to
 * the same rpc subject can answer first, and a forged billing reply poisons the gateway's
 * entitlements cache for every request that follows it.
 */
export const replyEnvelope = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    requestId: z.string().min(1),
    signature: z.string().min(16),
    data: z.unknown(),
  }),
  z.object({
    ok: z.literal(false),
    requestId: z.string().min(1),
    signature: z.string().min(16),
    error: z.object({
      code: z.string(),
      message: z.string(),
      data: z.unknown().optional(),
    }),
  }),
]);

export type ReplyEnvelope<TData = unknown> =
  | { ok: true; requestId: string; signature: string; data: TData }
  | {
      ok: false;
      requestId: string;
      signature: string;
      error: { code: string; message: string; data?: unknown };
    };

export type ParsedReplyEnvelope = z.infer<typeof replyEnvelope>;

/** Every evt.* body. A service emits the fact, never the request that produced it. */
export const EVENT_OUTCOMES = ["success"] as const;

export const eventPayload = z.object({ outcome: z.enum(EVENT_OUTCOMES) });

export type EventPayload = z.infer<typeof eventPayload>;

/* ── Canonical form ──────────────────────────────────────────────────────── */

/** Object.entries narrowed once, so no caller below has to index a bare `object`. */
function entriesOf(value: object): readonly (readonly [string, unknown])[] {
  return Object.entries(value);
}

function canonicalise(value: unknown): unknown {
  if (value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Cannot canonicalise an invalid Date.");
    return value.toISOString();
  }
  if (Array.isArray(value)) return value.map(canonicalise);
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`Cannot canonicalise the number ${String(value)}.`);
      }
      return value;
    case "object": {
      const sorted = [...entriesOf(value)].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      const out: Record<string, unknown> = {};
      for (const [key, item] of sorted) {
        /**
         * Defined rather than assigned. `out[key] = ...` reaches Object.prototype's
         * `__proto__` setter instead of creating an own property, and JSON.parse does
         * produce a genuine own `__proto__` key - so that entry was read out of the input
         * here and then silently dropped before JSON.stringify ever saw it. `{}` and
         * `{"__proto__":{"role":"owner"}}` hashed identically, which made the one claim
         * this whole boundary rests on - that the MAC covers the payload - false. Every
         * contract input is a stripping z.object, so nothing reached it, but a zod
         * behaviour is not what should be holding a trust boundary shut.
         */
        Object.defineProperty(out, key, {
          value: canonicalise(item),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    default:
      throw new Error(`Cannot canonicalise a value of type ${typeof value}.`);
  }
}

/**
 * Stable stringification: object keys sorted at every depth, so two processes holding the
 * same value feed byte-identical input to the MAC.
 *
 * It encodes the JSON projection of a value, because JSON is what actually crosses the bus -
 * a Date is its ISO string on both sides. Anything JSON.stringify would silently drop or
 * corrupt throws instead: undefined, NaN, Infinity, a function. A value that changes between
 * signing and verifying is a MAC that covers less than it appears to, and an object with an
 * undefined property hashing the same as one without it is exactly that ambiguity.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

/** sha256 of the canonical form. Binds a body into a signature without copying it in. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("base64url");
}

/**
 * What kind of envelope a MAC covers. A request and the event it emits carry the SAME meta
 * and are signed with the same secret, so without this tag they are the same bytes over the
 * same fields: a captured event envelope is a syntactically valid command envelope for the
 * same operation, and the only thing standing between them is that the contract's input
 * happens to demand fields the event body does not have. That is a shape, not a control.
 * The tag makes the two MACs unforgeable for each other by construction.
 */
type MacDomain = "request" | "event";

/**
 * Which key signed these bytes. One value today and no key selection anywhere - this is a
 * reserved slot in the format, not a migration.
 *
 * It is here now because a change to the signed bytes is free only until the first real
 * message exists, and expensive forever afterwards. Making one breaking change instead of
 * two is the whole reason it is landing beside `domain`.
 *
 * NOTE, and this is the load-bearing part: `keyId` is deliberately NOT a field of
 * `requestMeta`, so it does not arrive on the wire and nothing reads one from a message.
 * A caller therefore cannot nominate the key that checks their own forgery - the JWT `kid`
 * confusion has no surface here because the choice is never offered. Both signer and
 * verifier take this value from their own build. When key rotation does arrive, the rule
 * that keeps that true is: resolve an id against a closed set the verifier owns, refuse an
 * unrecognised one outright, and never fall back to another key - an id may narrow the
 * search, it may never grant trust.
 */
export const KEY_IDS = ["v1"] as const;

export type KeyId = (typeof KEY_IDS)[number];

/** The only key this build signs with, and the only one it will verify against. */
export const CURRENT_KEY_ID: KeyId = "v1";

/**
 * The exact bytes an envelope signature covers: the domain, every field of the meta, and a
 * hash of the payload.
 *
 * The `satisfies` is the load-bearing part. `Record<keyof RequestMeta | "payloadHash" |
 * "domain" | "keyId", ...>` accepts no missing key and no extra one, so adding a field to
 * `requestMeta` without adding it here fails to compile. Without that, a new field lands on
 * the unsigned side of the boundary and nothing says so.
 */
function canonicalEnvelope(domain: MacDomain, meta: RequestMeta, payload: unknown): string {
  const canonical = {
    domain,
    keyId: CURRENT_KEY_ID,
    requestId: meta.requestId,
    orgId: meta.orgId,
    userId: meta.userId,
    role: meta.role,
    permissions: [...meta.permissions].sort(),
    plan: meta.plan,
    resource: meta.resource,
    operation: meta.operation,
    issuedAt: meta.issuedAt,
    deadlineAt: meta.deadlineAt,
    /**
     * `?? null`, never undefined: exactOptionalPropertyTypes is on, and an absent value has
     * to canonicalise to something rather than disappear from the signed bytes.
     */
    traceparent: meta.traceparent ?? null,
    payloadHash: contentHash(payload),
  } satisfies Record<keyof RequestMeta | "payloadHash" | "domain" | "keyId", unknown>;
  return canonicalJson(canonical);
}

export function canonicalRequest(meta: RequestMeta, payload: unknown): string {
  return canonicalEnvelope("request", meta, payload);
}

/** The same fields under a different domain, so an event MAC can never verify as a request. */
export function canonicalEvent(meta: RequestMeta, payload: unknown): string {
  return canonicalEnvelope("event", meta, payload);
}

/**
 * What a reply signature is bound to. `requestId` alone was not enough: it is chosen by the
 * caller - the proxy echoes an inbound x-request-id back out - so a captured reply could be
 * aimed at a DIFFERENT operation that reuses the same id, and neither the id check nor the
 * signature check would notice. Naming the operation in the signed bytes is what stops that.
 */
export type ReplyBinding = {
  readonly requestId: string;
  readonly resource: string;
  readonly operation: string;
  readonly ok: boolean;
};

/**
 * The exact bytes a reply signature covers: what it answers, and the body it answers with.
 *
 * The `satisfies` does the same job here as in `canonicalEnvelope`: `Record<keyof
 * ReplyBinding | "dataHash" | "keyId", ...>` accepts no missing key and no extra one, so a
 * field added to ReplyBinding that is not signed here fails to compile rather than sitting
 * unsigned. `keyId` is in here as well as in the envelope MAC on purpose: freezing the
 * format with only one of the two halves reserved would force the other to break later.
 */
export function canonicalReply(binding: ReplyBinding, data: unknown): string {
  const canonical = {
    keyId: CURRENT_KEY_ID,
    requestId: binding.requestId,
    resource: binding.resource,
    operation: binding.operation,
    ok: binding.ok,
    dataHash: contentHash(data),
  } satisfies Record<keyof ReplyBinding | "dataHash" | "keyId", unknown>;
  return canonicalJson(canonical);
}

/* ── Freshness ───────────────────────────────────────────────────────────── */

export type Transport = OperationRule["transport"];

/** Two seconds. Gateway and service run on different machines with different clocks. */
export const CLOCK_SKEW_MS = 2_000;

export type FreshnessVerdict =
  | { readonly fresh: true }
  | {
      readonly fresh: false;
      readonly code: Extract<ErrorCode, "UNTRUSTED_ENVELOPE" | "DEADLINE_EXCEEDED">;
      readonly message: string;
    };

/**
 * Bounds the signed clock fields, and applies the deadline only where somebody is waiting.
 *
 * A command is durable on purpose: cmd.member.create declares an 8s budget but JetStream
 * redelivers for as long as the stream keeps the message. Enforcing that budget on a command
 * means ten seconds of identity downtime silently discards every queued invitation - the
 * opposite of the durability the registry promised. The stream's max age expires a command;
 * the deadline is an rpc concern.
 */
export function checkFreshness(
  meta: RequestMeta,
  transport: Transport,
  now: number = Date.now(),
  skewMs: number = CLOCK_SKEW_MS,
): FreshnessVerdict {
  if (meta.issuedAt > now + skewMs) {
    return {
      fresh: false,
      code: "UNTRUSTED_ENVELOPE",
      message: "Envelope was issued in the future.",
    };
  }

  const budget = meta.deadlineAt - meta.issuedAt;
  if (budget <= 0 || budget > MAX_TIMEOUT_MS + skewMs) {
    return {
      fresh: false,
      code: "UNTRUSTED_ENVELOPE",
      message: "Envelope claims a budget no operation in the registry declares.",
    };
  }

  if (transport === "rpc" && meta.deadlineAt + skewMs <= now) {
    return {
      fresh: false,
      code: "DEADLINE_EXCEEDED",
      message: "Request expired before it was handled.",
    };
  }

  return { fresh: true };
}
