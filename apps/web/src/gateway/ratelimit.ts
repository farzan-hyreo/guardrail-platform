/**
 * SOT: rate-limit, ratelimit, throttle, ddos
 * WHAT   One limiter, two backends: Upstash in production, in-memory locally.
 * WHY    Rate limiting belongs at the gateway, before a message reaches the bus. A limit
 *        enforced inside a service has already paid for the work it is refusing.
 */
import "server-only";

import { env } from "@guardrail/env";

export type Verdict = { ok: boolean; retryAfterSeconds: number };

const buckets = new Map<string, { count: number; resetAt: number }>();
const upstash = env.upstash();
const disabled = !env.isProduction() && !env.rateLimitInDev();

export async function rateLimit(args: {
  key: string;
  max: number;
  windowSeconds: number;
}): Promise<Verdict> {
  if (disabled) return { ok: true, retryAfterSeconds: 0 };
  if (upstash !== null) return viaUpstash(args, upstash.url, upstash.token);

  const now = Date.now();
  const bucket = buckets.get(args.key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(args.key, { count: 1, resetAt: now + args.windowSeconds * 1000 });
    return { ok: true, retryAfterSeconds: 0 };
  }
  bucket.count += 1;
  if (bucket.count > args.max) {
    return { ok: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfterSeconds: 0 };
}

async function viaUpstash(
  args: { key: string; max: number; windowSeconds: number },
  url: string,
  token: string,
): Promise<Verdict> {
  const now = Date.now();
  const window = Math.floor(now / (args.windowSeconds * 1000));
  const redisKey = `rl:${args.key}:${window}`;
  try {
    const response = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCR", redisKey],
        ["EXPIRE", redisKey, String(args.windowSeconds)],
      ]),
      cache: "no-store",
    });
    if (!response.ok) return { ok: true, retryAfterSeconds: 0 };
    const payload = (await response.json()) as Array<{ result?: number }>;
    const count = payload[0]?.result ?? 0;
    if (count > args.max) {
      const resetAt = (window + 1) * args.windowSeconds * 1000;
      return { ok: false, retryAfterSeconds: Math.ceil((resetAt - now) / 1000) };
    }
    return { ok: true, retryAfterSeconds: 0 };
  } catch {
    // Fail open: never take the product down to enforce a quota.
    return { ok: true, retryAfterSeconds: 0 };
  }
}
