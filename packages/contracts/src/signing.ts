/**
 * SOT: signing, hmac, envelope-signature, verify-envelope
 * WHAT   Signs and verifies request envelopes with a shared secret.
 * WHY    The bus is inside the trust boundary but not above it: a compromised service or a
 *        stray script with NATS credentials should not be able to hand another service a
 *        forged org id. Cheap symmetric signing closes that.
 * HOW    Swap this file for asymmetric signing or NATS accounts when you outgrow one secret.
 * WHERE  @guardrail/guardrail
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalMeta, type RequestMeta } from "./envelope";

export function signMeta(meta: RequestMeta, secret: string): string {
  return createHmac("sha256", secret).update(canonicalMeta(meta)).digest("base64url");
}

export function verifyMeta(meta: RequestMeta, signature: string, secret: string): boolean {
  const expected = Buffer.from(signMeta(meta, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
