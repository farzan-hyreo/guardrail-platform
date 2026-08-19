/**
 * SOT: billing, autumn, entitlements-source, plan-lookup, checkout, metering, usage-tracking
 * WHAT   The only file that knows Autumn's API shape.
 * WHY    Billing SDKs change faster than products do. Everything above this file speaks
 *        `Entitlements` from the registry; if Autumn renames a field, one file changes.
 * HOW    The billing customer id is the organisation id. Plan and usage are read once per
 *        request and handed to the same pure gate the client uses.
 * HOW    The SDK RETURNS its errors - every call answers `{data, error}` and throws
 *        nothing - so a `try/catch` around it catches only transport faults and a failed
 *        call falls straight through as if it had succeeded. Every method here inspects
 *        `result.error` explicitly. See `unwrap`.
 * WHERE  services/billing, apps/web gateway entitlements cache
 * NOTE   Without AUTUMN_SECRET_KEY the adapter degrades to the free plan so the app boots
 *        on a fresh clone. It never silently grants a paid plan.
 * NOTE   biome.json turns style/useNamingConvention off for THIS FILE. `customer_id`,
 *        `feature_id`, `idempotency_key` and `success_url` are Autumn's wire names, not
 *        ours; this file exists precisely to be the one place they appear. biome.json takes
 *        no comments, so the reason lives here.
 */
import "server-only";

import { ServiceError } from "@guardrail/contracts";
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

/**
 * Autumn's customer payload, read defensively in exactly one place, and declaring ONLY the
 * fields this adapter actually reads.
 *
 * Narrow on purpose, and every optional spelled `?: T | undefined` rather than `?: T`.
 *
 * Both details exist to make the SDK's own `Customer` structurally assignable to this type,
 * which is what removes the `as AutumnCustomer` the old code needed - and that cast is what
 * let the Result object through as a customer in the first place. It previously also named
 * `balance` and `included_usage`, which nothing here reads. Under
 * `exactOptionalPropertyTypes` a bare `usage?: number` means "absent or a number" and
 * refuses "present and undefined", which is exactly what the SDK's zod-inferred optionals
 * are - so the shape written to describe the vendor's payload did not actually accept it.
 */
type AutumnCustomer = {
  products?: Array<{ id?: string | undefined; status?: string | undefined }> | undefined;
  features?: Record<string, { usage?: number | undefined }> | undefined;
};

/**
 * The SDK's `Result` shape, narrowed once.
 *
 * `{data, error}` where exactly one is non-null. The previous code wrote
 * `(response.data ?? response) as AutumnCustomer`, which on ANY failure handed `readPlan`
 * the Result object itself - it has no `products`, so `readPlan` returned DEFAULT_PLAN and
 * every paying organisation was silently served the free plan, cached at the gateway for
 * thirty seconds, with no log line and no exception. A refusal has to be a refusal.
 */
function unwrap<T>(result: { readonly data: T | null; readonly error: unknown }, what: string): T {
  if (result.error !== null || result.data === null) {
    throw new ServiceError(
      "SERVICE_UNAVAILABLE",
      `Autumn refused ${what}: ${JSON.stringify(result.error)}`,
    );
  }
  return result.data;
}

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

/**
 * Create the customer, ignoring "already exists".
 *
 * Autumn is the source of truth for its own customer records, so a create that collides is
 * the success case for an idempotent call, not a failure worth surfacing.
 */
async function createCustomer(
  client: NonNullable<typeof autumn>,
  organizationId: string,
): Promise<void> {
  await client.customers.create({ id: organizationId });
}

export const billing = {
  /**
   * Plan + usage for an organisation. One network call per request; the block caches it.
   *
   * A failure throws rather than returning FALLBACK. The gateway's entitlements dep already
   * knows how to degrade - it logs and returns EMPTY_ENTITLEMENTS *without caching it* - and
   * that is the correct place for the decision, because it is the only layer that knows the
   * difference between "billing said free" and "billing said nothing". Returning FALLBACK
   * from here made those two indistinguishable and pinned the wrong one in the cache.
   *
   * The retry is what makes an organisation's FIRST read work. Autumn has no customer until
   * something creates one, and the two paths that mint an organisation - the signup hook in
   * @guardrail/auth and `organization.create` in the identity service - are on the far side
   * of a service boundary from this file, so neither can call it directly without the kind
   * of cross-service reach the architecture forbids. Creating on demand keeps the knowledge
   * of Autumn's customer model inside Autumn's own adapter, which is the whole point of the
   * adapter, and it is idempotent, so it is also self-healing for any organisation that
   * predates this code.
   */
  async getEntitlements(organizationId: string): Promise<Entitlements> {
    if (!autumn) return FALLBACK;
    const first = await autumn.customers.get(organizationId);
    if (first.error === null && first.data !== null) {
      const customer: AutumnCustomer = first.data;
      return { plan: readPlan(customer), usage: readUsage(customer) };
    }
    // Bounded to exactly one extra round trip: if the customer genuinely exists and Autumn
    // is simply down, the retry fails the same way and `unwrap` refuses, loudly.
    await createCustomer(autumn, organizationId);
    const customer: AutumnCustomer = unwrap(
      await autumn.customers.get(organizationId),
      `entitlements for ${organizationId}`,
    );
    return { plan: readPlan(customer), usage: readUsage(customer) };
  },

  /**
   * Meter a consumed unit. Called by the metering consumer after a successful mutation.
   *
   * `requestId` becomes Autumn's idempotency key, which the installed SDK accepts on
   * `TrackParams`. Without it a redelivered `evt.*` - and the consumer is at-least-once by
   * design - counts twice, and the second count is indistinguishable from real usage, so it
   * moves a customer towards a limit they never reached.
   */
  async track(args: {
    organizationId: string;
    resource: ResourceKey;
    requestId: string;
    value?: number;
  }): Promise<void> {
    const featureId = RESOURCES[args.resource].featureId;
    if (!autumn || !featureId) return;
    const result = await autumn.track({
      customer_id: args.organizationId,
      feature_id: featureId,
      value: args.value ?? 1,
      idempotency_key: args.requestId,
    });
    // Throwing, not logging: the caller is a durable consumer, so a throw is a nak and
    // JetStream retries. A swallowed meter failure is revenue nothing ever reconciles.
    if (result.error !== null) {
      throw new Error(
        `[billing] track refused for ${args.resource}: ${JSON.stringify(result.error)}`,
      );
    }
  },

  /**
   * Set an absolute count for a non-consumable feature such as seats.
   *
   * This called `track` - an increment - so it did the opposite of its own doc comment, and
   * "set seats to 3" added three more. `autumn.usage` is the absolute-set endpoint. It had
   * no call site, so it never fired; it is fixed rather than deleted because an absolute
   * set is what a resource whose count can go DOWN needs, and `track` can only ever add.
   */
  async setUsage(args: {
    organizationId: string;
    resource: ResourceKey;
    usage: number;
  }): Promise<void> {
    const featureId = RESOURCES[args.resource].featureId;
    if (!autumn || !featureId) return;
    const result = await autumn.usage({
      customer_id: args.organizationId,
      feature_id: featureId,
      value: args.usage,
    });
    if (result.error !== null) {
      throw new Error(
        `[billing] setUsage refused for ${args.resource}: ${JSON.stringify(result.error)}`,
      );
    }
  },

  /** Start a checkout for a plan. Returns a URL when Stripe needs to be visited. */
  async checkout(args: {
    organizationId: string;
    plan: PlanKey;
    successUrl: string;
  }): Promise<{ url: string | null }> {
    if (!autumn) return { url: null };
    const data = unwrap(
      await autumn.attach({
        customer_id: args.organizationId,
        product_id: PLANS[args.plan].autumnProductId,
        success_url: args.successUrl,
      }),
      `checkout for ${args.organizationId}`,
    );
    return { url: data.checkout_url ?? null };
  },

  /**
   * Make sure an organisation exists as a billing customer, with its name and email.
   *
   * `getEntitlements` already creates a bare customer on demand, so this is not what keeps
   * a new tenant working - it is how a customer acquires the details a billing dashboard
   * and an invoice need. Idempotent, and safe to call more than once.
   */
  async ensureCustomer(args: {
    organizationId: string;
    name: string;
    email: string;
  }): Promise<void> {
    if (!autumn) return;
    // A collision is the success case for an idempotent call, so the result is deliberately
    // not inspected. Anything else Autumn refuses here is recoverable: `getEntitlements`
    // creates the customer on its next read.
    await autumn.customers.create({
      id: args.organizationId,
      name: args.name,
      email: args.email,
    });
  },
};
