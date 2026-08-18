/**
 * SOT: gate, gate-composition, composed-gate, client-mirror-ui
 * WHAT   The four gates applied in the order the platform applies them, behind one
 *        component: permission, then plan, then allowance.
 * WHY    The client mirror made visible. `<Gate>` owns no rule of its own any more - it
 *        composes AccessGate, FeatureGate and PriceGate, each of which calls the same
 *        registry function the gateway calls, so the UI cannot offer a button the
 *        platform will refuse.
 * HOW    <Gate resource="project" operation="create" fallback={<Upsell/>}>{children}</Gate>
 *        Reach for the primitives directly when the three answers deserve three answers.
 * WHERE  apps/web/src/features/*
 */
"use client";

import type { OperationOf, ResourceKey } from "@guardrail/registry";

import { AccessGate, usePermission } from "./access-gate";
import { FeatureGate, useResourceDecision } from "./feature-gate";
import { PriceGate } from "./price-gate";

export function Gate<K extends ResourceKey>({
  resource,
  operation,
  fallback = null,
  children,
}: {
  resource: K;
  operation: OperationOf<K>;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  // Permission denial hides (AccessGate renders nothing); either plan denial - not in the
  // plan, or no allowance left - shows the one fallback. Same three outcomes as before.
  return (
    <AccessGate resource={resource} operation={operation}>
      <FeatureGate resource={resource} fallback={fallback}>
        <PriceGate resource={resource} fallback={fallback}>
          {children}
        </PriceGate>
      </FeatureGate>
    </AccessGate>
  );
}

export function useAccess<K extends ResourceKey>(resource: K, operation: OperationOf<K>) {
  const permitted = usePermission(resource, operation);
  const decision = useResourceDecision(resource);
  return { permitted, decision, allowed: permitted && decision.allowed };
}
