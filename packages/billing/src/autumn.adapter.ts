/**
 * SOT: billing, autumn, entitlements-source, plan-lookup, checkout, metering, usage-tracking
 * WHAT   The only file that knows Autumn's API shape.
 * WHY    Billing SDKs change faster than products do. Everything above this file speaks
 *        `Entitlements` from the registry; if Autumn renames a field, one file changes.
 * HOW    The billing customer id is the organisation id. Plan and usage are read once per
 *        request and handed to the same pure gate the client uses.
 * WHERE  services/billing, apps/web gateway entitlements cache
 * NOTE   Without AUTUMN_SECRET_KEY the adapter degrades to the free plan so the app boots
 *        on a fresh clone. It never silently grants a paid plan.
 */
import "server-only";

import { env } from "@guardrail/env";
import {
  DEFAULT_PLAN,
  type Entitlements,
  PLANS,
  type PlanKey,
  planFromAutumnProductId,
  RESOURCE_KEYS,
  RESOURCES,
  type ResourceKey,
  type UsageSnapshot,
} from "@guardrail/registry";
import { Autumn } from "autumn-js";

const secretKey = env.autumnSecretKey();
const autumn = secretKey ? new Autumn({ secretKey }) : null;

const FALLBACK: Entitlements = { plan: DEFAULT_PLAN, usage: {} };

/** Autumn's customer payload, read defensively in exactly one place. */
type AutumnCustomer = {
  products?: Array<{ id?: string; status?: string }>;
  features?: Record<string, { usage?: number; balance?: number; included_usage?: number }>;
};

function readPlan(customer: AutumnCustomer): PlanKey {
  const candidates = (customer.products ?? [])
    .filter((product) => product.status !== "expired" && product.status !== "canceled")
    .map((product) => (product.id ? planFromAutumnProductId(product.id) : null))
    .filter((plan): plan is PlanKey => plan !== null);

  if (candidates.length === 0) return DEFAULT_PLAN;
  // Highest attached plan wins, so a mid-cycle upgrade never downgrades access.
  return candidates.reduce((best, plan) => (PLANS[plan].rank > PLANS[best].rank ? plan : best));
}

function readUsage(customer: AutumnCustomer): UsageSnapshot {
  const usage: Partial<Record<ResourceKey, number>> = {};
  for (const resource of RESOURCE_KEYS) {
    const featureId = RESOURCES[resource].featureId;
    if (!featureId) continue;
    const feature = customer.features?.[featureId];
    if (feature?.usage !== undefined) usage[resource] = feature.usage;
  }
  return usage;
}

export const billing = {
  /** Plan + usage for an organisation. One network call per request; the block caches it. */
  async getEntitlements(organizationId: string): Promise<Entitlements> {
    if (!autumn) return FALLBACK;
    try {
      const response = await autumn.customers.get(organizationId);
      const customer = (response.data ?? response) as AutumnCustomer;
      return { plan: readPlan(customer), usage: readUsage(customer) };
    } catch {
      // Billing outage must not lock paying customers out of the product.
      return FALLBACK;
    }
  },

  /** Meter a consumed unit. Called by the block after a successful mutation. */
  async track(args: {
    organizationId: string;
    resource: ResourceKey;
    value?: number;
  }): Promise<void> {
    const featureId = RESOURCES[args.resource].featureId;
    if (!autumn || !featureId) return;
    try {
      await autumn.track({
        customer_id: args.organizationId,
        feature_id: featureId,
        value: args.value ?? 1,
      });
    } catch (error) {
      console.error("[billing] track failed", { resource: args.resource, error });
    }
  },

  /** Set an absolute count for non-consumable features such as seats. */
  async setUsage(args: {
    organizationId: string;
    resource: ResourceKey;
    usage: number;
  }): Promise<void> {
    const featureId = RESOURCES[args.resource].featureId;
    if (!autumn || !featureId) return;
    try {
      await autumn.track({
        customer_id: args.organizationId,
        feature_id: featureId,
        value: args.usage,
      });
    } catch (error) {
      console.error("[billing] setUsage failed", { resource: args.resource, error });
    }
  },

  /** Start a checkout for a plan. Returns a URL when Stripe needs to be visited. */
  async checkout(args: {
    organizationId: string;
    plan: PlanKey;
    successUrl: string;
  }): Promise<{ url: string | null }> {
    if (!autumn) return { url: null };
    const response = await autumn.attach({
      customer_id: args.organizationId,
      product_id: PLANS[args.plan].autumnProductId,
      success_url: args.successUrl,
    });
    const data = (response.data ?? response) as { checkout_url?: string; url?: string };
    return { url: data.checkout_url ?? data.url ?? null };
  },

  /** Make sure an organisation exists as a billing customer. Idempotent. */
  async ensureCustomer(args: {
    organizationId: string;
    name: string;
    email: string;
  }): Promise<void> {
    if (!autumn) return;
    try {
      await autumn.customers.create({
        id: args.organizationId,
        name: args.name,
        email: args.email,
      });
    } catch {
      // Already exists. Autumn is the source of truth for its own customer records.
    }
  },
};
