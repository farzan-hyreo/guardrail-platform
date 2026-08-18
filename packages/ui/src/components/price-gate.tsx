/**
 * SOT: price-gate, limit-upsell, useUsageLabel, usage-headroom
 * WHAT   The limit half of the client mirror: the resource is in the plan, but the
 *        allowance for it is spent - now, or by the number this control is about to ask
 *        for.
 * WHY    The gateway refuses the same request with the same function and the same numbers,
 *        so a button and an endpoint cannot disagree about how many are left. Re-counting
 *        a limit in a component is how they start to.
 * HOW    <PriceGate resource="member" requested={2}>{children}</PriceGate>
 *        useUsageLabel("member") renders the registry's own "3 of 10".
 * WHERE  apps/web/src/features/*, ./gate
 */
"use client";

import { type ResourceKey, usageLabel } from "@guardrail/registry";

import { useResourceDecision } from "./feature-gate";
import { UpgradePrompt } from "./upgrade-prompt";
import { useViewer } from "./viewer";

/** "3 of 10", "12 used", "Not included" - phrased by the registry, never by the caller. */
export function useUsageLabel(resource: ResourceKey): string {
  const { entitlements } = useViewer();
  return usageLabel(resource, entitlements);
}

export function PriceGate({
  resource,
  requested,
  fallback,
  children,
}: {
  resource: ResourceKey;
  /** How many this control would consume. Defaults to the registry's own default of one. */
  requested?: number;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  const decision = useResourceDecision(resource, requested);

  if (!decision.allowed && decision.reason === "limit_reached") {
    return <>{fallback === undefined ? <UpgradePrompt decision={decision} /> : fallback}</>;
  }

  // Not being in the plan at all is FeatureGate's conversation, not this one.
  return <>{children}</>;
}
