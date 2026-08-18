/**
 * SOT: superseded-auth-endpoints, better-auth-supersession, auth-mount-policy
 * WHAT   The Better Auth organisation endpoints the registry has taken over, and the ones
 *        it deliberately has not.
 * WHY    Better Auth mounts eighteen organisation endpoints behind one catch-all. Six of
 *        them were a second door beside a gate that already worked - `invite-member` is
 *        `member.create`, `remove-member` is `member.delete` - and the rest ran with no
 *        role gate, no rate limit keyed on anything that existed, no plan gate and no
 *        evt.*, so deleting an organisation left no audit row. A route that is guarded on
 *        one path and open on another is not guarded.
 * HOW    Each entry names the registry operation that replaced it, typed
 *        `${ResourceKey}:${Operation}`, and the assertion below refuses to load if that
 *        operation is not one the registry declares. Removing an operation from the
 *        registry without removing its entry here is a boot failure, not a reopened door.
 *        Omission is the case this cannot catch on its own; tools/guardrail-check.ts is
 *        where that belongs.
 * WHERE  apps/web/src/app/api/auth/[...all]/route.ts
 */
import {
  isOperationOf,
  isResourceKey,
  type Operation,
  type ResourceKey,
} from "@guardrail/registry";

export type Permission = `${ResourceKey}:${Operation}`;

export type SupersededEndpoint = {
  /** The path segment Better Auth mounts, below /api/auth. */
  readonly path: string;
  /** The registry operation that now owns it. */
  readonly by: Permission;
  /** What a caller should use instead, named the way the tRPC client names it. */
  readonly instead: string;
};

/**
 * Eleven of the eighteen. The seven left mounted are listed in KEPT below with the reason,
 * because "we forgot" and "we decided" look identical in a file that only lists refusals.
 */
export const SUPERSEDED: readonly SupersededEndpoint[] = [
  { path: "organization/create", by: "organization:create", instead: "organization.create" },
  { path: "organization/update", by: "organization:update", instead: "organization.update" },
  { path: "organization/delete", by: "organization:delete", instead: "organization.remove" },
  {
    path: "organization/get-full-organization",
    by: "organization:read",
    instead: "organization.current",
  },
  { path: "organization/list-members", by: "member:read", instead: "member.list" },
  { path: "organization/invite-member", by: "member:create", instead: "member.invite" },
  { path: "organization/update-member-role", by: "member:update", instead: "member.setRole" },
  { path: "organization/remove-member", by: "member:delete", instead: "member.remove" },
  { path: "organization/list-invitations", by: "invitation:read", instead: "invitation.list" },
  {
    path: "organization/cancel-invitation",
    by: "invitation:delete",
    instead: "invitation.revoke",
  },
  { path: "organization/leave", by: "membership:delete", instead: "organization.leave" },
];

/**
 * Still mounted, on purpose. Each of these acts on something the envelope cannot name.
 * Written down because a deliberate gap and an oversight are indistinguishable otherwise.
 */
export const KEPT: Readonly<Record<string, string>> = {
  "organization/set-active":
    "Mutates the session, not the organisation. Services never see a session, and routing it would need an envelope scoped to the organisation being left in order to change which organisation the next envelope carries.",
  "organization/list":
    "Lists the caller's own memberships. User-scoped, not organisation-scoped: there is no organisation to put in an envelope, and it returns nothing that is not already theirs.",
  "organization/accept-invitation":
    "The actor is not yet a member, so ctx.orgId is empty or a different organisation. Belongs with the seat-counting work, not here.",
  "organization/reject-invitation":
    "Same as accept: the actor is not a member of that organisation.",
  "organization/get-invitation":
    "Same as accept, and read-only against an unguessable invitation id.",
  "organization/check-slug": "Read-only availability check. No tenant data crosses it.",
  "organization/has-permission":
    "Read-only, evaluates the caller's own role against the same res.* statements the registry generates.",
};

/**
 * Proved while the module loads, at `make dev` rather than on the first request: every
 * supersession has to name an operation the registry actually declares.
 */
const dangling = SUPERSEDED.filter((entry) => {
  const [resource, operation] = entry.by.split(":");
  if (resource === undefined || operation === undefined) return true;
  return !(isResourceKey(resource) && isOperationOf(resource, operation));
});
if (dangling.length > 0) {
  throw new Error(
    `These /api/auth endpoints are refused in favour of operations the registry does not declare: ${dangling
      .map((entry) => `${entry.path} -> ${entry.by}`)
      .join(
        ", ",
      )}. Either restore the operation in registry.ts or stop superseding the endpoint - as written, the endpoint is closed and nothing replaced it.`,
  );
}

const BY_PATH: ReadonlyMap<string, SupersededEndpoint> = new Map(
  SUPERSEDED.map((entry) => [entry.path, entry]),
);

/** The endpoint this request is asking for, or null if Better Auth still owns it. */
export function supersedes(pathname: string): SupersededEndpoint | null {
  const index = pathname.indexOf("/api/auth/");
  if (index < 0) return null;
  const rest = pathname.slice(index + "/api/auth/".length).replace(/\/+$/, "");
  return BY_PATH.get(rest) ?? null;
}
