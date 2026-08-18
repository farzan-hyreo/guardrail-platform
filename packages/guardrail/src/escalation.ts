/**
 * SOT: role-escalation, assignable-roles, privilege-escalation, gate-4b
 * WHAT   The one question both halves of the block ask before a role is handed out: is the
 *        role this request names one the caller is allowed to grant?
 * WHY    `assignableRoles` was written, documented and unit tested with no production call
 *        site, so an admin could invite an owner. The policy itself stays in the registry,
 *        derived from ROLE_RANK; this file is only the wire-boundary half - reading a role
 *        out of a body nothing has parsed yet - so gateway 4b and service 5b ask exactly
 *        the same question and cannot drift apart.
 * HOW    Returns the role that must be refused, or null when there is nothing to refuse.
 *        A name no organisation declares is refused too: the contract rejects it a step
 *        later anyway, and a gate that fails open on an unrecognised role is not a gate.
 * WHERE  packages/guardrail/src/gateway.ts, packages/guardrail/src/service.ts
 */
import { assignableRoles, type OrgRole } from "@guardrail/registry";

/**
 * `"role" in input` narrows the object without a cast, and the value stays `unknown` until
 * it is proven to be a string. This runs before the contract has parsed anything, which is
 * the point: the gate must not depend on the parse it precedes.
 */
function namedRole(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  if (!("role" in input)) return null;
  const value: unknown = input.role;
  return typeof value === "string" ? value : null;
}

export function refusedRole(input: unknown, actor: OrgRole): string | null {
  const requested = namedRole(input);
  if (requested === null) return null;
  return assignableRoles(actor).some((role) => role === requested) ? null : requested;
}
