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
import { defineResource, definePlan, op, type PlanDefinition, type ResourceDefinition } from "./define";

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

const upgradeCopy = (noun: string) => (nextPlanLabel: string | null): string =>
  nextPlanLabel === null
    ? `You have used every ${noun} on the highest plan. Talk to us about a custom limit.`
    : `You have used every ${noun} on your plan. ${nextPlanLabel} raises the limit.`;

/* ── Resources ───────────────────────────────────────────────────────────── */

export const RESOURCES = {
  project: defineResource({
    label: "Projects",
    description: "The top-level container a customer organises work in.",
    owner: "projects",
    featureId: "projects",
    operations: {
      read: op({ minRole: "member", kind: "query", transport: "rpc", consumes: false, audit: false, timeoutMs: 3000 }),
      create: op({ minRole: "admin", kind: "mutation", transport: "rpc", consumes: true, audit: true, timeoutMs: 5000 }),
      update: op({ minRole: "admin", kind: "mutation", transport: "rpc", consumes: false, audit: true, timeoutMs: 5000 }),
      delete: op({ minRole: "admin", kind: "mutation", transport: "rpc", consumes: false, audit: true, timeoutMs: 5000 }),
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
      read: op({ minRole: "member", kind: "query", transport: "rpc", consumes: false, audit: false, timeoutMs: 3000 }),
      // A command: sending an invitation involves an email provider that can be slow.
      create: op({ minRole: "admin", kind: "mutation", transport: "command", consumes: true, audit: true, timeoutMs: 8000 }),
      delete: op({ minRole: "owner", kind: "mutation", transport: "rpc", consumes: false, audit: true, timeoutMs: 5000 }),
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
      read: op({ minRole: "admin", kind: "query", transport: "rpc", consumes: false, audit: false, timeoutMs: 3000 }),
      delete: op({ minRole: "admin", kind: "mutation", transport: "rpc", consumes: false, audit: true, timeoutMs: 5000 }),
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
      read: op({ minRole: "admin", kind: "query", transport: "rpc", consumes: false, audit: false, timeoutMs: 4000 }),
      manage: op({ minRole: "owner", kind: "mutation", transport: "rpc", consumes: false, audit: true, timeoutMs: 8000 }),
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
      read: op({ minRole: "admin", kind: "query", transport: "rpc", consumes: false, audit: false, timeoutMs: 4000 }),
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
