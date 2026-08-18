/**
 * SOT: access-control, better-auth-roles, ac-statements, org-roles, statement-namespace
 * WHAT   Better Auth's organization access control, generated from the registry.
 * WHY    Better Auth needs its own statement and role objects. Hand-writing them creates a
 *        second permission model that drifts from the first. These are built from the same
 *        `PERMISSIONS_BY_ROLE` the gateway uses, so they cannot disagree.
 * HOW    Better Auth ships statements of its own - `organization`, `member`, `invitation`,
 *        `team`, `ac` - and the registry independently owns resources called `member` and
 *        `invitation`. Merging the two flat namespaces let the registry's version win, so
 *        `invitation` collapsed to read/delete and `member` lost `update`: no role in the
 *        product could invite anybody or change a member's role. Registry statements are
 *        therefore namespaced `res.<resource>`, which makes the merge a pure union that no
 *        registry key can ever shadow, and the union is proved at import time below.
 *        `roles` is built with `fromKeys(ORG_ROLES, ...)` over an OrgRole-keyed table of
 *        Better Auth base roles, so adding an org role is a compile error until it is
 *        mapped rather than a second, silent permission model.
 * WHERE  @guardrail/auth/server, @guardrail/auth/client
 */
import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

import { fromKeys, keysOf, ORG_ROLES, type OrgRole } from "./define";
import { operationsOf, PERMISSIONS_BY_ROLE, RESOURCE_KEYS } from "./derive";
import type { ResourceKey } from "./registry";

/** The namespace registry resources occupy inside Better Auth's statement object. */
export type StatementKey = `res.${ResourceKey}`;

export function statementKey(resource: ResourceKey): StatementKey {
  return `res.${resource}`;
}

/**
 * Entries are built from the exact key list, so no assertion is introduced here.
 * Actions widen to string[] for Better Auth's benefit; the exact operation unions are
 * still enforced everywhere that matters, by the registry and the contract map.
 */
const resourceStatements: Record<string, string[]> = Object.fromEntries(
  RESOURCE_KEYS.map((resource): readonly [StatementKey, string[]] => [
    statementKey(resource),
    [...operationsOf(resource)],
  ]),
);

export const statement = { ...defaultStatements, ...resourceStatements };

/**
 * A namespace is only a guarantee while something checks it. Better Auth owns the bare
 * keys, the registry owns `res.*`, and this throws while the module is loading if the two
 * ever meet - at `make dev`, not on the first owner who tries to invite somebody.
 *
 * The check is deliberately on the namespaced keys rather than on RESOURCE_KEYS itself:
 * the registry legitimately declares resources called `member` and `invitation`, and that
 * overlap is exactly what the prefix exists to make harmless.
 */
const reservedStatements: readonly string[] = keysOf(defaultStatements);
const shadowed: readonly string[] = RESOURCE_KEYS.map(statementKey).filter((key) =>
  reservedStatements.some((reserved) => reserved === key),
);
if (shadowed.length > 0) {
  throw new Error(
    `Registry statements collide with Better Auth's own: ${shadowed.join(", ")}. ` +
      "Change the res. prefix in packages/registry/src/access.ts - a collision here " +
      "silently removes permissions from every role.",
  );
}

export const ac = createAccessControl(statement);

const grantsByRole = fromKeys(ORG_ROLES, (role: OrgRole) => {
  const held = new Set<string>(PERMISSIONS_BY_ROLE[role]);
  const grants: Record<string, string[]> = {};
  for (const resource of RESOURCE_KEYS) {
    const allowed = operationsOf(resource).filter((operation) =>
      held.has(`${resource}:${operation}`),
    );
    if (allowed.length > 0) grants[statementKey(resource)] = [...allowed];
  }
  return grants;
});

/**
 * The Better Auth role each org role starts from, keyed by OrgRole. A role added to
 * ORG_ROLES fails to compile here until someone decides which of Better Auth's own
 * organization permissions it holds - there is no default that would quietly grant or
 * withhold them.
 */
const baseStatements: Readonly<Record<OrgRole, Readonly<Record<string, readonly string[]>>>> = {
  member: memberAc.statements,
  admin: adminAc.statements,
  owner: ownerAc.statements,
};

/**
 * The role list Better Auth sees, derived from ORG_ROLES rather than written out, so it
 * cannot fall behind the list the gateway and the registry use.
 */
export const roles = fromKeys(ORG_ROLES, (role: OrgRole) =>
  ac.newRole({ ...baseStatements[role], ...grantsByRole[role] }),
);
