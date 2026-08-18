/**
 * SOT: feature-gate, plan-inclusion, not-in-plan, useResourceDecision
 * WHAT   The plan half of the client mirror: is this resource in the viewer's plan at all?
 * WHY    "Not on your plan" and "you have used all of yours" are two different sales
 *        conversations, and collapsing them tells a paying customer their feature is
 *        missing. This gate answers only the first; PriceGate answers the second.
 * HOW    <FeatureGate resource="auditLog">{children}</FeatureGate> - with no fallback the
 *        registry's own upgrade copy is shown; pass one to say it differently.
 * WHERE  apps/web/src/features/*, ./price-gate, ./gate
 */
"use client";

import { type AccessDecision, checkResourceAccess, type ResourceKey } from "@guardrail/registry";

import { UpgradePrompt } from "./upgrade-prompt";
import { useViewer } from "./viewer";

/**
 * The registry's decision for this viewer, read from context. Every gate here goes
 * through it, so the browser asks the same pure function the gateway asked - once, over
 * entitlements the dashboard layout already fetched.
 */
export function useResourceDecision(resource: ResourceKey, requested?: number): AccessDecision {
  const { entitlements } = useViewer();
  // exactOptionalPropertyTypes: absent and "present but undefined" are different states.
  return checkResourceAccess({
    resource,
    entitlements,
    ...(requested === undefined ? {} : { requested }),
  });
}

export function FeatureGate({
  resource,
  fallback,
  children,
}: {
  resource: ResourceKey;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  const decision = useResourceDecision(resource);

  if (!decision.allowed && decision.reason === "not_in_plan") {
    return <>{fallback === undefined ? <UpgradePrompt decision={decision} /> : fallback}</>;
  }

  // A spent allowance inside the plan is PriceGate's conversation, not this one.
  return <>{children}</>;
}
