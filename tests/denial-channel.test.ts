/**
 * SOT: denial-channel-assertions, structured-failure-test, superjson-error-strip
 * WHAT   Proves the gateway's structured denial survives the trip to the browser.
 *        Run with `pnpm tsx tests/denial-channel.test.ts`.
 * WHY    The gateway computes a four-arm `GatewayFailure` carrying the plan decision, the
 *        retry seconds and the refused permission, and the UI is supposed to match on
 *        `error.data.app.code` to choose an upgrade prompt over a red toast. None of it
 *        arrived. `new TRPCError({cause})` wraps a plain object in an Error subclass, and
 *        superjson's Error transformer emits `{name, message}` and drops every own
 *        property - so `code` was `undefined` in the browser and all four call sites fell
 *        back to printing the message as an error. Nothing failed; the feature was simply
 *        never reachable, which is why it needs a test rather than a comment.
 * HOW    Runs the real `TRPCError` and the real `superjson` the gateway is configured with,
 *        not a model of them. The first check pins the behaviour that caused the bug, so if
 *        a future tRPC or superjson release changes it the test says so instead of silently
 *        agreeing. The second check is the actual contract: what `errorFormatter` puts on
 *        `data.app` must still carry `code` after a round trip.
 * WHERE  apps/web/src/gateway/init.ts (appFailure), packages/ui/src/components/denial.tsx
 */
import assert from "node:assert/strict";

import { TRPCError } from "@trpc/server";
import superjson from "superjson";

// The real function, imported rather than reproduced. A local copy of it would let this
// test keep passing while the gateway it is meant to guard drifted underneath it.
import { appFailure } from "../apps/web/src/gateway/init";

/** The shape `errorFormatter` returns, reduced to the part under test. */
type Shape = { message: string; data: { app: unknown } };

function roundTrip(shape: Shape): Shape {
  return superjson.deserialize<Shape>(superjson.serialize(shape));
}

const UPGRADE = {
  code: "UPGRADE_REQUIRED",
  message: "You have used every project on the Free plan.",
  decision: { allowed: false, reason: "limit_reached", used: 3, limit: 3 },
};

const RATE_LIMITED = {
  code: "RATE_LIMITED",
  message: "Too many requests. Try again shortly.",
  retryAfterSeconds: 42,
};

function causeOf(failure: { code: string; message: string }): unknown {
  return new TRPCError({ code: "FORBIDDEN", message: failure.message, cause: failure }).cause;
}

function readCode(value: unknown): unknown {
  if (value === null || typeof value !== "object" || !("code" in value)) return undefined;
  return value.code;
}

type Check = { name: string; run: () => void };

const checks: Check[] = [
  {
    name: "the bug this guards against is real: an Error cause loses every own property",
    run: () => {
      const cause = causeOf(UPGRADE);
      assert.ok(cause instanceof Error, "tRPC no longer wraps a plain cause in an Error");
      // Passing the cause through directly - what init.ts used to do.
      const delivered = roundTrip({ message: UPGRADE.message, data: { app: cause } });
      assert.equal(
        readCode(delivered.data.app),
        undefined,
        "superjson now preserves Error properties. If this starts passing, the workaround in init.ts may be removable - check before removing it.",
      );
    },
  },
  {
    name: "UPGRADE_REQUIRED survives with its code and its decision",
    run: () => {
      const app = appFailure(causeOf(UPGRADE), UPGRADE.message);
      const delivered = roundTrip({ message: UPGRADE.message, data: { app } });
      assert.equal(readCode(delivered.data.app), "UPGRADE_REQUIRED");
      assert.deepEqual(delivered.data.app, {
        code: "UPGRADE_REQUIRED",
        message: UPGRADE.message,
        decision: UPGRADE.decision,
      });
    },
  },
  {
    name: "RATE_LIMITED survives with its retry seconds",
    run: () => {
      const app = appFailure(causeOf(RATE_LIMITED), RATE_LIMITED.message);
      const delivered = roundTrip({ message: RATE_LIMITED.message, data: { app } });
      assert.equal(readCode(delivered.data.app), "RATE_LIMITED");
      assert.deepEqual(delivered.data.app, {
        code: "RATE_LIMITED",
        message: RATE_LIMITED.message,
        retryAfterSeconds: 42,
      });
    },
  },
  {
    name: "a cause that is not a structured failure yields null rather than a half-object",
    run: () => {
      assert.equal(appFailure(new Error("boom"), "boom"), null);
      assert.equal(appFailure(null, "boom"), null);
      assert.equal(appFailure("nope", "boom"), null);
    },
  },
];

let failures = 0;
for (const check of checks) {
  try {
    check.run();
    console.log(`PASS  ${check.name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${check.name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${checks.length - failures}/${checks.length} passed`);
if (failures > 0) process.exit(1);
