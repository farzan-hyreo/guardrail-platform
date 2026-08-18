/**
 * SOT: redis-replay-probe, idempotency-verification, accept-then-refuse
 * WHAT   Proves the local Redis-backed dedup stack (infra/docker-compose.yml's `redis` +
 *        `redis-http`) behaves the way `apps/web/src/gateway/replay.ts`'s
 *        `UpstashReplayStore.claim()` assumes: a `SET key value NX PX ttl` succeeds exactly
 *        once per key, and every later call for the same key is refused until it expires.
 * WHY    "gr-017 closes the replay window" is a claim. The interesting half - that a second,
 *        genuine delivery of the same command is refused rather than re-executed - is the
 *        half no amount of running the app locally will ever exercise, because nothing sends
 *        a legitimate command twice on purpose. This sends the exact protocol call twice on
 *        purpose and asserts the second one is refused.
 * HOW    Plain JavaScript, no build, no install, no workspace import: talks straight to the
 *        Upstash-compatible REST endpoint over `fetch`, the same protocol
 *        `UpstashReplayStore` uses and the same one Upstash itself exposes in production, so
 *        this is a real test of the wire protocol the store depends on, not a mock of it.
 *        Takes the endpoint as CLI args rather than env vars, the same way verify.mjs takes
 *        the NATS server - a probe should not need turbo's env-var dependency list.
 * WHERE  Run against a stack started by `make up` (or `pnpm infra:up`):
 *          node infra/redis/probe.mjs
 *          node infra/redis/probe.mjs http://127.0.0.1:8079 dev-token
 *        Exits non-zero if either half of accept-then-refuse does not hold.
 */
const URL = process.argv[2] ?? "http://127.0.0.1:8079";
const TOKEN = process.argv[3] ?? "dev-token";

async function command(parts) {
  const response = await fetch(`${URL}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify([parts]),
  });
  if (!response.ok) {
    throw new Error(`${URL} responded ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  return payload[0]?.result;
}

console.info(`Probing ${URL}`);

// Mirrors a durable command's real key shape: replay:<service>:<resource>.<operation>:<requestId>
const requestId = `probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const key = `replay:billing:track.usage:${requestId}`;
const ttlMs = "5000";

const first = await command(["SET", key, "1", "NX", "PX", ttlMs]);
const firstAccepted = first === "OK";
console.info(`  genuine command  (1st delivery) -> ${firstAccepted ? "accepted" : "REFUSED"}`);

const second = await command(["SET", key, "1", "NX", "PX", ttlMs]);
const secondAccepted = second === "OK";
console.info(`  replayed command (2nd delivery) -> ${secondAccepted ? "ACCEPTED" : "refused"}`);

if (!firstAccepted) {
  console.error("\nFAIL: the genuine, first delivery of a command must be accepted.");
  process.exit(1);
}
if (secondAccepted) {
  console.error("\nFAIL: a replayed command must be refused - it was accepted instead.");
  process.exit(1);
}

console.info("\naccept-then-refuse holds: a genuine command lands once, a replay does not.");
