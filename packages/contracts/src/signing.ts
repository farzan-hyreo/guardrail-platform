/**
 * SOT: signing, hmac, envelope-signature, verify-envelope, reply-signature
 * WHAT   Signs and verifies request envelopes and rpc replies with a shared secret.
 * WHY    The bus is inside the trust boundary but not above it: a compromised service or a
 *        stray script with NATS credentials should not be able to hand another service a
 *        forged org id, nor hand the gateway a forged answer. Cheap symmetric signing closes
 *        both directions.
 * HOW    Every signature is an HMAC over a canonical form built in envelope.ts - never over
 *        an ad hoc string built here, because two call sites that disagree about the bytes
 *        produce a MAC that covers whichever fields they happen to share.
 *        Swap this file for asymmetric signing or NATS accounts when you outgrow one secret.
 * WHERE  @guardrail/guardrail, @guardrail/transport
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  canonicalEvent,
  canonicalReply,
  canonicalRequest,
  type ReplyBinding,
  type RequestMeta,
} from "./envelope";

function hmac(canonical: string, secret: string): string {
  return createHmac("sha256", secret).update(canonical).digest("base64url");
}

/** Constant time, with the length guard `timingSafeEqual` requires before it will run. */
function matches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Covers the meta AND the payload. A signature over the meta alone is a swappable body. */
export function signRequest(meta: RequestMeta, payload: unknown, secret: string): string {
  return hmac(canonicalRequest(meta, payload), secret);
}

/**
 * A body that cannot be canonicalised - `1e999` parses to Infinity - was never signed by
 * anyone either. Refuse it rather than letting the throw escape the verifier. Shared by
 * every verifier below so that rule cannot hold in one of them and not the others.
 */
function verifyAgainst(sign: () => string, signature: string): boolean {
  let expected: string;
  try {
    expected = sign();
  } catch {
    return false;
  }
  return matches(expected, signature);
}

export function verifyRequest(
  meta: RequestMeta,
  payload: unknown,
  signature: string,
  secret: string,
): boolean {
  return verifyAgainst(() => signRequest(meta, payload, secret), signature);
}

/**
 * An emitted fact, signed under its own domain. `signRequest` would produce bytes that are
 * also a valid command envelope for the same meta - see `MacDomain` in envelope.ts.
 */
export function signEvent(meta: RequestMeta, payload: unknown, secret: string): string {
  return hmac(canonicalEvent(meta, payload), secret);
}

export function verifyEvent(
  meta: RequestMeta,
  payload: unknown,
  signature: string,
  secret: string,
): boolean {
  return verifyAgainst(() => signEvent(meta, payload, secret), signature);
}

/**
 * Covers the outcome and the body, bound to the request AND the operation it answers. The
 * binding is one object rather than three adjacent strings, which is the kind of argument
 * list that gets transposed once and then verifies the wrong thing for a year.
 *
 * Verify with the resource and operation YOU asked for, never with values read back off the
 * reply - a binding taken from the thing being checked checks nothing.
 */
export function signReply(binding: ReplyBinding, data: unknown, secret: string): string {
  return hmac(canonicalReply(binding, data), secret);
}

export function verifyReply(
  binding: ReplyBinding,
  data: unknown,
  signature: string,
  secret: string,
): boolean {
  return verifyAgainst(() => signReply(binding, data, secret), signature);
}
