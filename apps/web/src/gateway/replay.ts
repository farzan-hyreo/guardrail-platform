/**
 * SOT: replay-guard, idempotency-store, replay-dedup
 * WHAT   Two Redis-backed dedup primitives for the gateway: a self-expiring claim for the
 *        rpc path, and an idempotent reply cache for the command path.
 * WHY    JetStream's dedupe window is two minutes and its msgID is attacker-controlled, so
 *        it is not a security control. A captured, validly signed event or command replays
 *        forever otherwise - no MAC work fixes a replay of legitimately signed bytes. The
 *        rpc and command paths need different shapes: an rpc call either lands once inside
 *        its deadline or it does not matter any more, so a claim that expires with the
 *        deadline is enough. A command is durable and is *meant* to be redelivered at least
 *        once, so the second delivery has to return the same answer instead of
 *        re-executing - the store here is the idempotency guarantee, not a decoration on
 *        top of one.
 * HOW    Same shape as `ratelimit.ts`: a backend selected once at module init, Upstash in
 *        production, in-memory locally, loud at boot if production has no Upstash config.
 *        Unlike the rate limiter, the fail-open/fail-closed decision on a store outage is
 *        deliberately NOT made in this file - a query may tolerate it, a mutation or a
 *        command must not, and only the call site (which reads the registry's
 *        `kind`/`transport`) knows which one this is. So every read reports
 *        `"unavailable"` instead of guessing, and the caller decides.
 * WHERE  packages/guardrail/src/service.ts - the injected call site, step 2b, after
 *        envelope verification and before any handler work
 */
import "server-only";

import { type ParsedReplyEnvelope, replyEnvelope } from "@guardrail/contracts";
import { env } from "@guardrail/env";

export type ReplayClaim = "fresh" | "duplicate" | "unavailable";

interface ReplayStore {
  /** SET NX PX under `replay:`. "fresh" if this call created the key, "duplicate" if it already existed. */
  claim(key: string, ttlMs: number): Promise<ReplayClaim>;
  /** The stored reply for an idempotency key under `idem:`, or null if none exists yet. */
  recall(key: string): Promise<string | null | "unavailable">;
  /** Store the reply for an idempotency key under `idem:`, overwriting any previous value. */
  remember(key: string, value: string, ttlMs: number): Promise<void>;
}

class InMemoryReplayStore implements ReplayStore {
  private readonly claims = new Map<string, number>();
  private readonly replies = new Map<string, { value: string; expiresAt: number }>();

  // No network I/O here, so no `await` - returning `Promise.resolve` directly (instead of
  // declaring this `async`) keeps it honest with the `useAwait` lint rule while still
  // satisfying `ReplayStore`, which is async for the Upstash backend's sake.
  claim(key: string, ttlMs: number): Promise<ReplayClaim> {
    const now = Date.now();
    const expiresAt = this.claims.get(key);
    if (expiresAt !== undefined && expiresAt > now) return Promise.resolve("duplicate");
    this.claims.set(key, now + ttlMs);
    return Promise.resolve("fresh");
  }

  recall(key: string): Promise<string | null | "unavailable"> {
    const entry = this.replies.get(key);
    if (entry === undefined || entry.expiresAt <= Date.now()) return Promise.resolve(null);
    return Promise.resolve(entry.value);
  }

  remember(key: string, value: string, ttlMs: number): Promise<void> {
    this.replies.set(key, { value, expiresAt: Date.now() + ttlMs });
    return Promise.resolve();
  }
}

class UpstashReplayStore implements ReplayStore {
  private readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  private async command(parts: readonly string[]): Promise<unknown> {
    const response = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      // Header names are case-insensitive per RFC 7230 3.2; lowercase satisfies the lint
      // rule for identifier-shaped object keys without changing what goes over the wire.
      headers: { authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify([parts]),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Upstash responded ${response.status}`);
    const payload = (await response.json()) as Array<{ result: unknown }>;
    return payload[0]?.result;
  }

  async claim(key: string, ttlMs: number): Promise<ReplayClaim> {
    try {
      const result = await this.command(["SET", `replay:${key}`, "1", "NX", "PX", String(ttlMs)]);
      // Upstash returns the string "OK" when SET NX wrote the key, and nil (null) when it
      // already existed - "the claim succeeds only if the reply is not nil".
      return result === "OK" ? "fresh" : "duplicate";
    } catch {
      return "unavailable";
    }
  }

  async recall(key: string): Promise<string | null | "unavailable"> {
    try {
      const result = await this.command(["GET", `idem:${key}`]);
      return typeof result === "string" ? result : null;
    } catch {
      return "unavailable";
    }
  }

  async remember(key: string, value: string, ttlMs: number): Promise<void> {
    try {
      await this.command(["SET", `idem:${key}`, value, "PX", String(ttlMs)]);
    } catch {
      // A failed write here is not a security event: the next redelivery finds nothing in
      // `recall` and re-executes the handler, which is exactly the at-least-once behaviour
      // this store exists to improve on, not a behaviour it is required to prevent. Only a
      // failed `recall`/`claim` needs the caller's fail-open/fail-closed policy.
    }
  }
}

function selectStore(): ReplayStore {
  const upstash = env.upstash();
  if (upstash !== null) return new UpstashReplayStore(upstash.url, upstash.token);

  if (env.isProduction()) {
    throw new Error(
      "Replay/idempotency dedup is unconfigured in production. Set " +
        "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. Without a shared store, a " +
        "captured, validly signed event or command can be replayed forever - no MAC work " +
        "fixes a replay of legitimately signed bytes.",
    );
  }

  return new InMemoryReplayStore();
}

const store = selectStore();

/**
 * RPC path: a self-expiring claim keyed by (service, resource.operation, requestId).
 * `ttlMs` is the caller's to compute - `deadlineAt - now + skew` - because only the caller
 * knows the operation's deadline.
 */
export function claimReplay(key: string, ttlMs: number): Promise<ReplayClaim> {
  return store.claim(key, ttlMs);
}

/** Command path: the previously stored reply for an idempotency key, if any. */
export async function recallReply(
  key: string,
): Promise<ParsedReplyEnvelope | null | "unavailable"> {
  const raw = await store.recall(key);
  if (raw === "unavailable" || raw === null) return raw;
  return replyEnvelope.parse(JSON.parse(raw));
}

/**
 * Command path: remember a reply so a redelivery returns it instead of re-executing.
 * `ttlMs` is the caller's to compute - at least the CMD stream's max age (7 days), so the
 * cache outlives every possible redelivery.
 */
export async function rememberReply(
  key: string,
  reply: ParsedReplyEnvelope,
  ttlMs: number,
): Promise<void> {
  await store.remember(key, JSON.stringify(reply), ttlMs);
}
