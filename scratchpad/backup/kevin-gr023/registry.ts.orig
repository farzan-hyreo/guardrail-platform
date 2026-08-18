/**
 * SOT: registry, source-of-truth, resources, plans, limits, feature-gates, permissions-source,
 *      nav-source, rate-limits, service-ownership, operation-rules
 * WHAT   The declaration. Plans and resources, and nothing computed.
 * WHY    One file to edit, one shape to follow. Everything else in the platform - permission
 *        strings, TypeScript unions, Better Auth roles, NATS subjects, queue groups, nav,
 *        route guards, plan gates, timeouts, audit and metering - is derived from this file
 *        by derive.ts. Adding an entry here is the whole change.
 * HOW    Copy an existing entry. Run `pnpm typecheck`: the errors that appear are the work.
 * WHERE  derive.ts, access.ts, @guardrail/contracts, @guardrail/guardrail
 * EDIT   This is the only file in the package you edit by hand.
 */
import {
  definePlan,
  defineResource,
  op,
  type PlanDefinition,
  type ResourceDefinition,
} from "./define";

/* ── Plans ───────────────────────────────────────────────────────────────── */

export const PLANS = {
  free: definePlan({
    label: "Free",
    tagline: "Enough to build something real.",
    autumnProductId: "free",
    rank: 0,
    priceMonthlyUsd: 0,
  }),
  pro: definePlan({
    label: "Pro",
    tagline: "For a team that ships weekly.",
    autumnProductId: "pro",
    rank: 1,
    priceMonthlyUsd: 29,
  }),
  scale: definePlan({
    label: "Scale",
    tagline: "Usage without the ceiling.",
    autumnProductId: "scale",
    rank: 2,
    priceMonthlyUsd: 99,
  }),
} satisfies Record<string, PlanDefinition>;

export type PlanKey = keyof typeof PLANS;
export const DEFAULT_PLAN = "free" satisfies PlanKey;

const upgradeCopy =
  (noun: string) =>
  (nextPlanLabel: string | null): string =>
    nextPlanLabel === null
      ? `You have used every ${noun} on the highest plan. Talk to us about a custom limit.`
      : `You have used every ${noun} on your plan. ${nextPlanLabel} raises the limit.`;

/* ── Resources ───────────────────────────────────────────────────────────── */

export const RESOURCES = {
  /**
   * The tenant itself. Better Auth mounts HTTP endpoints for these at /api/auth, and every
   * one of them bypassed all eleven gates: no minRole, no permission, no rate limit keyed
   * on anything that exists, no plan gate, and no evt.* - so deleting an organisation left
   * no audit row. Declaring it here is what puts it back inside the block.
   *
   * `create` is deliberately not the endpoint a new user calls. A user's first workspace is
   * created server-side at signup, so it cannot be looped; this operation is the one that
   * makes a *second* one, which is why it is owner-only and counts against the plan. The
   * automatic first workspace is not metered, so `limits` counts workspaces beyond it.
   */
  organization: defineResource({
    label: "Organisations",
    description: "The tenant itself: its name, slug and lifecycle. The first one is free.",
    owner: "identity",
    featureId: "organizations",
    operations: {
      read: op({
        minRole: "member",
        kind: "query",
        transport: "rpc",
        consumes: false,
        audit: false,
        timeoutMs: 3000,
      }),
      create: op({
        minRole: "owner",
        kind: "mutation",
        transport: "rpc",
        consumes: true,
        audit: true,
        timeoutMs: 5000,
      }),
      update: op({
        minRole: "admin",
        kind: "mutation",
        transport: "rpc",
        consumes: false,
        audit: true,
        timeoutMs: 5000,
      }),
      delete: op({
        minRole: "owner",
        kind: "mutation",
        transport: "rpc",
        consumes: false,
        audit: true,
        timeoutMs: 5000,
      }),
    },
    limits: { free: false, pro: 3, scale: "unlimited" },
    rateLimit: { max: 10, windowSeconds: 60 },
    nav: null,
    upgrade: (next) =>
      next === null
        ? "You have used every organisation on the highest plan. Talk to us about a custom limit."
        : `Your plan includes one organisation. ${next} lets you run several.`,
  }),

  /**
   * Leaving is not the same act as removing somebody, so it is not the same operation.
   * `member.delete` means "remove a person" and is owner-only; this means "remove myself"
   * and every member may do it. Folding the two together would have forced member.delete
   * down to minRole member and moved an "is this your own row" test into a handler - a gate
   * decided by feature code is the one thing the block exists to prevent.
   */
  membership: defineResource({
    label: "Membership",
    description: "The caller's own seat in the organisation.",
    owner: "identity",
    featureId: null,
    operations: {
      delete: op({
        minRole: "member",
        kind: "mutation",
        transport: "rpc",
        consumes: false,
        audit: true,
        timeoutMs: 5000,
      }),
    },
    limits: { free: "unlimited", pro: "unlimited", scale: "unlimited" },
    rateLimit: { max: 5, windowSeconds: 60 },
    nav: null,
    upgrade: () => "Leaving an organisation is available on every plan.",
  }),

  project: defineResource({
    label: "Projects",
    description: "The top-level container a customer organises work in.",
    owner: "projects",
    featureId: "projects",
    operations: {
      read: op({
        minRole: "member",
        kind: "query",
        transport: "rpc",
        consumes: false,
        audit: false,
        timeoutMs: 3000,
      }),
      create: op({
        minRole: "admin",
        kind: "mutation",
        transport: "rpc",
        consumes: true,
        audit: true,
        timeoutMs: 5000,
      }),
      update: op({
        minRole: "admin",
        kind: "mutation",
        transport: "rpc",
        consumes: false,
        audit: true,
        timeoutMs: 5000,
      }),
      delete: op({
        minRole: "admin",
        kind: "mutation",
        transport: "rpc",
        consumes: false,
        audit: true,
        timeoutMs: 5000,
      }),
    },
    limits: { free: 2, pro: 25, scale: "unlimited" },
    rateLimit: { max: 60, windowSeconds: 60 },
    nav: { href: "/projects", label: "Projects", order: 1 },
    upgrade: upgradeCopy("project"),
  }),

  member: defineResource({
    label: "Team",
    description: "People with a seat in the organisation.",
    owner: "identity",
    featureId: "seats",
    operations: {
      read: op({
        minRole: "member",
        kind: "query",
        transport: "rpc",
        consumes: false,
        audit: false,
        timeoutMs: 3000,
      }),
      // A command: sending an invitation involves an email provider that can be slow.
      create: op({
        minRole: "admin",
        kind: "mutation",
        transport: "command",
        consumes: true,
        audit: true,
        timeoutMs: 8000,
      }),
      /**
       * Changing somebody's role. Owner-only, because an admin who can grant `owner` is an
       * admin who can take the organisation: nothing compared the requested role to the
       * caller's, and Better Auth's own update-member-role endpoint carried no such check
       * either. The handler additionally refuses a role above the caller's own, so the gate
       * and the service agree rather than one trusting the other.
       */
      update: op({
        minRole: "owner",
        kind: "mutation",
        transport: "rpc",
        consumes: false,
        audit: true,
        timeoutMs: 5000,
      }),
      delete: op({
        minRole: "owner",
        kind: "mutation",
        transport: "rpc",
        consumes: false,
        audit: true,
        timeoutMs: 5000,
      }),
    },
    limits: { free: 2, pro: 10, scale: "unlimited" },
    rateLimit: { max: 30, windowSeconds: 60 },
    nav: { href: "/team", label: "Team", order: 2 },
    upgrade: upgradeCopy("seat"),
  }),

  invitation: defineResource({
    label: "Invitations",
    description: "Pending invites to join the organisation.",
    owner: "identity",
    featureId: null,
    operations: {
      read: op({
        minRole: "admin",
        kind: "query",
        transport: "rpc",
        consumes: false,
        audit: false,
        timeoutMs: 3000,
      }),
      delete: op({
        minRole: "admin",
        kind: "mutation",
        transport: "rpc",
        consumes: false,
        audit: true,
        timeoutMs: 5000,
      }),
    },
    limits: { free: 5, pro: "unlimited", scale: "unlimited" },
    rateLimit: { max: 10, windowSeconds: 60 },
    nav: null,
    upgrade: upgradeCopy("invitation"),
  }),

  billing: defineResource({
    label: "Billing",
    description: "Plan, entitlements and checkout.",
    owner: "billing",
    featureId: null,
    operations: {
      read: op({
        minRole: "admin",
        kind: "query",
        transport: "rpc",
        consumes: false,
        audit: false,
        timeoutMs: 4000,
      }),
      manage: op({
        minRole: "owner",
        kind: "mutation",
        transport: "rpc",
        consumes: false,
        audit: true,
        timeoutMs: 8000,
      }),
    },
    limits: { free: "unlimited", pro: "unlimited", scale: "unlimited" },
    rateLimit: { max: 20, windowSeconds: 60 },
    nav: { href: "/billing", label: "Billing", order: 3 },
    upgrade: () => "Billing is available on every plan.",
  }),

  auditLog: defineResource({
    label: "Audit log",
    description: "Immutable record of every mutation the gateway allowed.",
    owner: "audit",
    featureId: null,
    operations: {
      read: op({
        minRole: "admin",
        kind: "query",
        transport: "rpc",
        consumes: false,
        audit: false,
        timeoutMs: 4000,
      }),
    },
    limits: { free: false, pro: 90, scale: "unlimited" },
    rateLimit: { max: 30, windowSeconds: 60 },
    nav: { href: "/audit", label: "Audit log", order: 4 },
    upgrade: (next) =>
      next === null
        ? "Audit retention is already unlimited."
        : `Audit history is not included in your plan. ${next} keeps it.`,
  }),
} satisfies Record<string, ResourceDefinition>;

export type ResourceKey = keyof typeof RESOURCES;
