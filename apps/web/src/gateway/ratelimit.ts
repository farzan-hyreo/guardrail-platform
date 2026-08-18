/**
 * SOT: rate-limit, ratelimit, throttle, ddos
 * WHAT   One limiter, two backends: Upstash in production, in-memory locally.
 * WHY    Rate limiting belongs at the gateway, before a message reaches the bus. A limit
 *        enforced inside a service has already paid for the work it is refusing. A missing
 *        Upstash config in production must fail loud at boot, not degrade into one bucket
 *        map per replica - that silently turns a declared max of N into N x replicas.
 * HOW    The backend is selected once at module init, mirroring `required()` in
 *        `@guardrail/env`: no Upstash config in production throws, unless
 *        `RATE_LIMIT_ALLOW_IN_MEMORY` opts a genuine single-instance deploy in (and warns
 *        on every boot when it does). That is a different failure class from a runtime
 *        Upstash outage, which still fails open in `UpstashStore.incr` exactly as before -
 *        an outage in a live backend must not take the product down, but a backend that was
 *        never configured is a deploy mistake the operator needs to see immediately.
 * WHERE  apps/web/src/gateway/deps.ts
 */
import "server-only";

import { env } from "@guardrail/env";

export type Verdict = { ok: boolean; retryAfterSeconds: number };

interface RateLimitStore {
  incr(key: string, windowSeconds: number): Promise<{ count: number; resetAt: number }>;
}

class InMemoryStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  // No network I/O here, so no `await` - returning `Promise.resolve` directly (instead of
  // declaring this `async`) keeps it honest with the `useAwait` lint rule while still
  // satisfying the `RateLimitStore` interface, which is async for `UpstashStore`'s sake.
  incr(key: string, windowSeconds: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowSeconds * 1000 };
      this.buckets.set(key, fresh);
      return Promise.resolve(fresh);
    }
    bucket.count += 1;
    return Promise.resolve(bucket);
  }
}

class UpstashStore implements RateLimitStore {
  private readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  async incr(key: string, windowSeconds: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const window = Math.floor(now / (windowSeconds * 1000));
    const redisKey = `rl:${key}:${window}`;
    const resetAt = (window + 1) * windowSeconds * 1000;
    try {
      const response = await fetch(`${this.url}/pipeline`, {
        method: "POST",
        // Header names are case-insensitive per RFC 7230 3.2; lowercase satisfies the lint
        // rule for identifier-shaped object keys without changing what goes over the wire.
        headers: { authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify([
          ["INCR", redisKey],
          ["EXPIRE", redisKey, String(windowSeconds)],
        ]),
        cache: "no-store",
      });
      if (!response.ok) return { count: 0, resetAt };
      const payload = (await response.json()) as Array<{ result?: number }>;
      const count = payload[0]?.result ?? 0;
      return { count, resetAt };
    } catch {
      // Fail open: a live Upstash outage must never take the product down. This is the
      // other failure class from `selectStore` below - a backend that stops answering at
      // runtime is not the same problem as a backend that was never configured at boot, and
      // treating them the same would turn a transient network blip into an outage of the
      // entire gateway. Reporting count 0 here means the caller always sees `ok: true`.
      return { count: 0, resetAt };
    }
  }
}

function selectStore(): RateLimitStore {
  const upstash = env.upstash();
  if (upstash !== null) return new UpstashStore(upstash.url, upstash.token);

  if (env.isProduction()) {
    if (env.rateLimitAllowInMemory()) {
      console.warn(
        "[ratelimit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set in " +
          "production. Falling back to an in-memory limiter because " +
          "RATE_LIMIT_ALLOW_IN_MEMORY is set. This is only correct for a genuine " +
          "single-instance deployment: every replica enforces its own limit " +
          "independently, so N replicas would honour up to N x the declared max.",
      );
      return new InMemoryStore();
    }
    throw new Error(
      "Rate limiting is unconfigured in production. Set UPSTASH_REDIS_REST_URL and " +
        "UPSTASH_REDIS_REST_TOKEN, or set RATE_LIMIT_ALLOW_IN_MEMORY=on for a genuine " +
        "single-instance deployment. Without one of these, each replica would enforce its " +
        "own limit independently, turning a declared max of N requests per window into " +
        "N x replicas.",
    );
  }

  return new InMemoryStore();
}

const store = selectStore();
const disabled = !env.isProduction() && !env.rateLimitInDev();

export async function rateLimit(args: {
  key: string;
  max: number;
  windowSeconds: number;
}): Promise<Verdict> {
  if (disabled) return { ok: true, retryAfterSeconds: 0 };

  const now = Date.now();
  const { count, resetAt } = await store.incr(args.key, args.windowSeconds);
  if (count > args.max) {
    return { ok: false, retryAfterSeconds: Math.ceil((resetAt - now) / 1000) };
  }
  return { ok: true, retryAfterSeconds: 0 };
}
