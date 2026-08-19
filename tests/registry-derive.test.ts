/**
 * SOT: registry-derive-assertions
 * WHAT   Plain assertions for the registry's role-normalisation and access-decision logic.
 *        Run with `pnpm tsx tests/registry-derive.test.ts` - no test runner, no config, no
 *        new dependency.
 * WHY    normalizeRole and checkResourceAccess are the two functions a browser and the
 *        gateway must never disagree on; this pins their contract without a DOM.
 * WHERE  packages/registry/src/derive.ts
 */
import assert from "node:assert/strict";

import {
  assignableRoles,
  checkResourceAccess,
  normalizeRole,
} from "../packages/registry/src/index";

type Check = { name: string; run: () => void };

const checks: Check[] = [
  {
    name: "normalizeRole('owner,admin') -> owner",
    run: () => assert.equal(normalizeRole("owner,admin"), "owner"),
  },
  {
    name: "normalizeRole('admin,owner') -> owner",
    run: () => assert.equal(normalizeRole("admin,owner"), "owner"),
  },
  {
    name: "normalizeRole('root') -> member (unrecognised degrades to lowest)",
    run: () => assert.equal(normalizeRole("root"), "member"),
  },
  {
    name: "normalizeRole(null) -> member (never escalates)",
    run: () => assert.equal(normalizeRole(null), "member"),
  },
  {
    name: "assignableRoles('admin') excludes owner",
    run: () => assert.deepEqual(assignableRoles("admin"), ["member", "admin"]),
  },
  {
    name: "assignableRoles('owner') includes all three roles",
    run: () => assert.deepEqual(assignableRoles("owner"), ["member", "admin", "owner"]),
  },
  {
    name: "checkResourceAccess: auditLog on free (not in plan at all) -> reason 'not_in_plan'",
    run: () => {
      const decision = checkResourceAccess({
        resource: "auditLog",
        entitlements: { plan: "free", usage: {} },
      });
      assert.equal(decision.allowed, false);
      if (decision.allowed) throw new Error("unreachable");
      assert.equal(decision.reason, "not_in_plan");
    },
  },
  {
    name: "checkResourceAccess: project on pro at its cap of 25 -> reason 'limit_reached'",
    run: () => {
      const decision = checkResourceAccess({
        resource: "project",
        entitlements: { plan: "pro", usage: { project: 25 } },
      });
      assert.equal(decision.allowed, false);
      if (decision.allowed) throw new Error("unreachable");
      assert.equal(decision.reason, "limit_reached");
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
