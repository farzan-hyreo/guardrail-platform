/**
 * SOT: define, registry-pattern, defineResource, fromKeys, registry-primitives
 * WHAT   The pattern every registry entry follows, and the one type assertion in the package.
 * WHY    Seven files with three different shapes was three patterns to learn. Everything is
 *        now declared with `defineResource` / `definePlan` and derived by one pipeline.
 * HOW    `const` type parameters preserve literal types without `as const`, so a resource
 *        is written as plain data and still produces exact unions.
 * WHERE  registry.ts (declaration), derive.ts (everything computed from it)
 * NOTE   Client-safe. No server-only import may ever be added to this package.
 */

/* ── Vocabulary ──────────────────────────────────────────────────────────── */

export const OPERATIONS = ["create", "read", "update", "delete", "manage"] as const;
export type Operation = (typeof OPERATIONS)[number];

export const ORG_ROLES = ["member", "admin", "owner"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** The deployable units. A resource names the one service allowed to answer for it. */
export const SERVICES = ["projects", "identity", "billing", "audit"] as const;
export type ServiceName = (typeof SERVICES)[number];

/** `false` means the resource is not in that plan at all. */
export type Limit = number | "unlimited" | false;

/* ── The single assertion ────────────────────────────────────────────────── */

/**
 * Builds an exhaustive `Record<K, V>` by visiting every key exactly once.
 *
 * This is the ONLY type assertion in the registry, and it is provably total: the loop
 * iterates the same key list the return type is keyed on. Every other derived value in
 * the package is built with this, so there is one place to audit rather than a cast at
 * each call site.
 */
export function fromKeys<K extends string, V>(keys: readonly K[], map: (key: K) => V): Record<K, V> {
  const out: Partial<Record<K, V>> = {};
  for (const key of keys) out[key] = map(key);
  return out as Record<K, V>;
}

/** Object.keys with the key type kept. Safe because the object literal is closed. */
export function keysOf<T extends object>(value: T): ReadonlyArray<Extract<keyof T, string>> {
  return Object.keys(value) as Array<Extract<keyof T, string>>;
}

/* ── Plans ───────────────────────────────────────────────────────────────── */

export type PlanDefinition = {
  readonly label: string;
  readonly tagline: string;
  /** Autumn product id. Autumn is downstream of the registry, never the other way round. */
  readonly autumnProductId: string;
  /** Higher rank means more entitlements. Drives upgrade prompts and plan comparison. */
  readonly rank: number;
  readonly priceMonthlyUsd: number;
};

export function definePlan<const T extends PlanDefinition>(plan: T): T {
  return plan;
}

/* ── Resources ───────────────────────────────────────────────────────────── */

export type OperationRule = {
  /** Minimum org role. Enforced at the gateway, asserted again at the service. */
  readonly minRole: OrgRole;
  /** query -> tRPC .query and a NATS request. mutation -> .mutation. */
  readonly kind: "query" | "mutation";
  /** rpc: caller waits. command: durable JetStream, executed at least once later. */
  readonly transport: "rpc" | "command";
  /** Counts against the plan limit. The gateway refuses before the bus is touched. */
  readonly consumes: boolean;
  /** Emit evt.<resource>.<operation> on success. Audit and metering consume it. */
  readonly audit: boolean;
  /** How long the gateway waits before giving up on the service. */
  readonly timeoutMs: number;
};

export function op<const T extends OperationRule>(rule: T): T {
  return rule;
}

export type NavEntry = {
  readonly href: string;
  readonly label: string;
  readonly order: number;
};

export type ResourceDefinition = {
  readonly label: string;
  readonly description: string;
  readonly owner: ServiceName;
  /** Autumn feature id, or null when the resource is not metered. */
  readonly featureId: string | null;
  /** Declared operations. A key absent here cannot be called from anywhere. */
  readonly operations: Readonly<Partial<Record<Operation, OperationRule>>>;
  readonly limits: Readonly<Record<string, Limit>>;
  readonly rateLimit: { readonly max: number; readonly windowSeconds: number };
  readonly nav: NavEntry | null;
  readonly upgrade: (nextPlanLabel: string | null) => string;
};

export function defineResource<const T extends ResourceDefinition>(resource: T): T {
  return resource;
}
