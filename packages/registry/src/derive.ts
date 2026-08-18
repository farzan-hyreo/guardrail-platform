/**
 * SOT: derive, derived-registry, permissions, entitlements, subjects, nav, streams,
 *      plan-limits, feature-gate, client-mirror, role-rank, queue-groups
 * WHAT   Every view of the registry, computed from registry.ts by one pipeline.
 * WHY    Six things need the same facts - gateway, service, bus, browser, nav and billing.
 *        Computed here, they cannot disagree, and there is no parallel list to maintain.
 * HOW    Nothing in this file is written by hand. If you are about to type a value that
 *        could be computed from registry.ts, compute it here instead.
 * WHERE  index.ts, and through it every package in the platform
 * EDIT   Do not add data here. Data goes in registry.ts.
 */
import {
  OPERATIONS,
  ORG_ROLES,
  SERVICES,
  fromKeys,
  keysOf,
  type Limit,
  type NavEntry,
  type Operation,
  type OperationRule,
  type OrgRole,
  type ServiceName,
} from "./define";
import { DEFAULT_PLAN, PLANS, RESOURCES, type PlanKey, type ResourceKey } from "./registry";

/* ── Keys and guards ─────────────────────────────────────────────────────── */

export const PLAN_KEYS: readonly PlanKey[] = keysOf(PLANS);
export const RESOURCE_KEYS: readonly ResourceKey[] = keysOf(RESOURCES);

/** Operations a resource actually declared. An absent key cannot be called anywhere. */
export type OperationOf<K extends ResourceKey> = Extract<
  keyof (typeof RESOURCES)[K]["operations"],
  Operation
>;

export function isResourceKey(value: unknown): value is ResourceKey {
  return typeof value === "string" && RESOURCE_KEYS.some((key) => key === value);
}

export function isOperation(value: unknown): value is Operation {
  return typeof value === "string" && OPERATIONS.some((operation) => operation === value);
}

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && PLAN_KEYS.some((key) => key === value);
}

/** Narrows an untrusted operation string against the resource that must declare it. */
export function isOperationOf<K extends ResourceKey>(
  resource: K,
  value: unknown,
): value is OperationOf<K> {
  return typeof value === "string" && value in RESOURCES[resource].operations;
}

const OPERATION_INDEX: Readonly<Record<ResourceKey, readonly Operation[]>> = fromKeys(
  RESOURCE_KEYS,
  (resource) => OPERATIONS.filter((operation) => operation in RESOURCES[resource].operations),
);

export function operationsOf<K extends ResourceKey>(resource: K): readonly OperationOf<K>[] {
  return OPERATION_INDEX[resource].filter((operation): operation is OperationOf<K> =>
    isOperationOf(resource, operation),
  );
}

export function ruleFor<K extends ResourceKey>(resource: K, operation: OperationOf<K>): OperationRule {
  const rule = RESOURCES[resource].operations[operation as Operation];
  if (rule === undefined) {
    throw new Error(`Undeclared operation ${String(operation)} on resource ${resource}.`);
  }
  return rule;
}

export function resourcesOwnedBy(service: ServiceName): readonly ResourceKey[] {
  return RESOURCE_KEYS.filter((resource) => RESOURCES[resource].owner === service);
}

export const OWNERSHIP: Readonly<Record<ServiceName, readonly ResourceKey[]>> = fromKeys(
  SERVICES,
  resourcesOwnedBy,
);

/* ── Plans ───────────────────────────────────────────────────────────────── */

export const PLANS_ASCENDING: readonly PlanKey[] = [...PLAN_KEYS].sort(
  (a, b) => PLANS[a].rank - PLANS[b].rank,
);

export function planRank(plan: PlanKey): number {
  return PLANS[plan].rank;
}

export function isAtLeastPlan(current: PlanKey, required: PlanKey): boolean {
  return planRank(current) >= planRank(required);
}

export function nextPlanAfter(plan: PlanKey): PlanKey | null {
  const index = PLANS_ASCENDING.indexOf(plan);
  const next = index < 0 ? undefined : PLANS_ASCENDING[index + 1];
  return next ?? null;
}

export function planFromAutumnProductId(productId: string): PlanKey | null {
  return PLAN_KEYS.find((key) => PLANS[key].autumnProductId === productId) ?? null;
}

/* ── Permissions ─────────────────────────────────────────────────────────── */

export type Permission = { [K in ResourceKey]: `${K}:${OperationOf<K>}` }[ResourceKey];

export function toPermission<K extends ResourceKey, O extends OperationOf<K>>(
  resource: K,
  operation: O,
): `${K}:${O}` {
  return `${resource}:${operation}`;
}

export const PERMISSIONS: readonly Permission[] = RESOURCE_KEYS.flatMap((resource) =>
  operationsOf(resource).map((operation) => toPermission(resource, operation)),
);

export const ROLE_RANK: Readonly<Record<OrgRole, number>> = { member: 1, admin: 2, owner: 3 };

export const ROLES_ASCENDING: readonly OrgRole[] = [...ORG_ROLES].sort(
  (a, b) => ROLE_RANK[a] - ROLE_RANK[b],
);

export function roleAtLeast(actual: OrgRole, required: OrgRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/** Every permission a role holds, from each operation's declared minRole. */
export const PERMISSIONS_BY_ROLE: Readonly<Record<OrgRole, readonly Permission[]>> = fromKeys(
  ORG_ROLES,
  (role) =>
    RESOURCE_KEYS.flatMap((resource) =>
      operationsOf(resource)
        .filter((operation) => roleAtLeast(role, ruleFor(resource, operation).minRole))
        .map((operation) => toPermission(resource, operation)),
    ),
);

export function permissionsForRole(role: OrgRole): readonly Permission[] {
  return PERMISSIONS_BY_ROLE[role];
}

/**
 * Takes the resource and operation rather than a pre-built string, so no call site has to
 * assert that a template literal is a member of the Permission union.
 */
export function can<K extends ResourceKey, O extends OperationOf<K>>(
  held: readonly Permission[],
  resource: K,
  operation: O,
): boolean {
  return held.includes(toPermission(resource, operation));
}

/** An unrecognised role from an identity provider degrades down, never up. */
export function normalizeRole(value: unknown): OrgRole {
  return ORG_ROLES.find((role): boolean => role === value) ?? "member";
}

/* ── Entitlements: the client mirror ─────────────────────────────────────── */

export type UsageSnapshot = Readonly<Partial<Record<ResourceKey, number>>>;

export type Entitlements = {
  readonly plan: PlanKey;
  readonly usage: UsageSnapshot;
};

export const EMPTY_ENTITLEMENTS: Entitlements = { plan: DEFAULT_PLAN, usage: {} };

export type AccessDecision =
  | { readonly allowed: true; readonly limit: Limit; readonly remaining: number | "unlimited" }
  | {
      readonly allowed: false;
      readonly reason: "not_in_plan" | "limit_reached";
      readonly limit: Limit;
      readonly used: number;
      readonly nextPlan: PlanKey | null;
      readonly upgradeMessage: string;
    };

export function limitFor(resource: ResourceKey, plan: PlanKey): Limit {
  return RESOURCES[resource].limits[plan] ?? false;
}

export function isInPlan(resource: ResourceKey, plan: PlanKey): boolean {
  return limitFor(resource, plan) !== false;
}

/**
 * The single gate. The gateway calls it to refuse; the browser calls it to render an
 * upgrade prompt. One implementation is the only reason the two cannot disagree.
 */
export function checkResourceAccess(args: {
  resource: ResourceKey;
  entitlements: Entitlements;
  requested?: number;
}): AccessDecision {
  const { resource, entitlements } = args;
  const requested = args.requested ?? 1;
  const limit = limitFor(resource, entitlements.plan);
  const used = entitlements.usage[resource] ?? 0;
  const nextPlan = nextPlanAfter(entitlements.plan);
  const upgradeMessage = RESOURCES[resource].upgrade(nextPlan === null ? null : PLANS[nextPlan].label);

  if (limit === false) {
    return { allowed: false, reason: "not_in_plan", limit, used, nextPlan, upgradeMessage };
  }
  if (limit === "unlimited") {
    return { allowed: true, limit, remaining: "unlimited" };
  }
  if (used + requested > limit) {
    return { allowed: false, reason: "limit_reached", limit, used, nextPlan, upgradeMessage };
  }
  return { allowed: true, limit, remaining: Math.max(0, limit - used) };
}

export function usageLabel(resource: ResourceKey, entitlements: Entitlements): string {
  const limit = limitFor(resource, entitlements.plan);
  const used = entitlements.usage[resource] ?? 0;
  if (limit === false) return "Not included";
  if (limit === "unlimited") return `${used} used`;
  return `${used} of ${limit}`;
}

/* ── Subjects and streams ────────────────────────────────────────────────── */

export function rpcSubject<K extends ResourceKey, O extends OperationOf<K>>(
  resource: K,
  operation: O,
): `rpc.${K}.${O}` {
  return `rpc.${resource}.${operation}`;
}

export function commandSubject<K extends ResourceKey, O extends OperationOf<K>>(
  resource: K,
  operation: O,
): `cmd.${K}.${O}` {
  return `cmd.${resource}.${operation}`;
}

export function eventSubject<K extends ResourceKey, O extends OperationOf<K>>(
  resource: K,
  operation: O,
): `evt.${K}.${O}` {
  return `evt.${resource}.${operation}`;
}

/** One queue group per service, so replicas share work instead of duplicating it. */
export function queueGroup(service: ServiceName): `qg.${ServiceName}` {
  return `qg.${service}`;
}

export type StreamConfig = {
  readonly name: string;
  readonly subjects: readonly string[];
  readonly description: string;
  readonly maxAgeDays: number;
};

export const STREAMS: readonly StreamConfig[] = [
  {
    name: "CMD",
    subjects: ["cmd.>"],
    description: "Durable commands the gateway accepted but has not executed yet.",
    maxAgeDays: 7,
  },
  {
    name: "EVT",
    subjects: ["evt.>"],
    description: "Facts emitted by services after a successful mutation.",
    maxAgeDays: 30,
  },
];

export type SubjectRoute = {
  readonly resource: ResourceKey;
  readonly operation: Operation;
  readonly subject: string;
  readonly transport: OperationRule["transport"];
  readonly owner: ServiceName;
  readonly audit: boolean;
};

/** Every subject the platform may legally use. Printed by `pnpm subjects`. */
export const ROUTES: readonly SubjectRoute[] = RESOURCE_KEYS.flatMap((resource) =>
  operationsOf(resource).map((operation) => {
    const rule = ruleFor(resource, operation);
    return {
      resource,
      operation,
      transport: rule.transport,
      owner: RESOURCES[resource].owner,
      audit: rule.audit,
      subject:
        rule.transport === "rpc"
          ? rpcSubject(resource, operation)
          : commandSubject(resource, operation),
    };
  }),
);

export function allSubjects(): readonly string[] {
  return ROUTES.flatMap((route) =>
    route.audit ? [route.subject, `evt.${route.resource}.${route.operation}`] : [route.subject],
  );
}

/* ── Navigation and the route guard ──────────────────────────────────────── */

export type NavItem = NavEntry & { readonly resource: ResourceKey };

export const NAV_ITEMS: readonly NavItem[] = RESOURCE_KEYS.flatMap((resource) => {
  const nav = RESOURCES[resource].nav;
  return nav === null ? [] : [{ ...nav, resource }];
}).sort((a, b) => a.order - b.order);

/** Longest-prefix match, so /projects/abc still resolves to the project resource. */
export function resourceForPath(pathname: string): ResourceKey | null {
  let match: NavItem | null = null;
  for (const item of NAV_ITEMS) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (match === null || item.href.length > match.href.length) match = item;
    }
  }
  return match === null ? null : match.resource;
}

export type NavAccess = { readonly visible: boolean; readonly locked: boolean };

/**
 * `visible` answers permission, `locked` answers plan. A resource the role may not read is
 * hidden; one the plan does not include is shown but locked, because a locked item is an
 * upgrade prompt and a hidden one is just confusing.
 */
export function navAccess(
  resource: ResourceKey,
  role: OrgRole,
  entitlements: Entitlements,
): NavAccess {
  const readable = operationsOf(resource).find(
    (operation) => operation === "read" || operation === "manage",
  );
  if (readable === undefined) return { visible: false, locked: false };
  return {
    visible: roleAtLeast(role, ruleFor(resource, readable).minRole),
    locked: !isInPlan(resource, entitlements.plan),
  };
}

export function visibleNav(role: OrgRole, entitlements: Entitlements): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => navAccess(item.resource, role, entitlements).visible);
}
