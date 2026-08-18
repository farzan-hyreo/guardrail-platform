/**
 * SOT: access-control, better-auth-roles, ac-statements, org-roles
 * WHAT   Better Auth's organization access control, generated from the registry.
 * WHY    Better Auth needs its own statement and role objects. Hand-writing them creates a
 *        second permission model that drifts from the first. These are built from the same
 *        `PERMISSIONS_BY_ROLE` the gateway uses, so they cannot disagree.
 * HOW    Imported by both the server auth instance and the browser client, which is why it
 *        is not re-exported from index.ts: barrelling it would pull Better Auth's access
 *        module into every bundle that touches the registry.
 * WHERE  @guardrail/auth (server), @guardrail/auth/client (browser)
 */
import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

import { ORG_ROLES, fromKeys, type OrgRole } from "./define";
import { PERMISSIONS_BY_ROLE, RESOURCE_KEYS, operationsOf } from "./derive";

/**
 * Built with the registry's own exhaustive helper, so no assertion is introduced here.
 * Actions widen to string[] for Better Auth's benefit; the exact operation unions are
 * still enforced everywhere that matters, by the registry and the contract map.
 */
const resourceStatements: Record<string, string[]> = fromKeys(RESOURCE_KEYS, (resource) => [
  ...operationsOf(resource),
]);

export const statement = { ...defaultStatements, ...resourceStatements };

export const ac = createAccessControl(statement);

const grantsByRole = fromKeys(ORG_ROLES, (role: OrgRole) => {
  const held = new Set<string>(PERMISSIONS_BY_ROLE[role]);
  const grants: Record<string, string[]> = {};
  for (const resource of RESOURCE_KEYS) {
    const allowed = operationsOf(resource).filter((operation) =>
      held.has(`${resource}:${operation}`),
    );
    if (allowed.length > 0) grants[resource] = [...allowed];
  }
  return grants;
});

export const owner = ac.newRole({ ...ownerAc.statements, ...grantsByRole.owner });
export const admin = ac.newRole({ ...adminAc.statements, ...grantsByRole.admin });
export const member = ac.newRole({ ...memberAc.statements, ...grantsByRole.member });

export const roles = { owner, admin, member };
