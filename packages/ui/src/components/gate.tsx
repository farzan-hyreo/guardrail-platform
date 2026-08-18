/**
 * SOT: gate, feature-gate-component, upgrade-prompt, client-mirror-ui
 * WHAT   One component that hides, disables or upsells based on permission and plan.
 * WHY    The client mirror made visible. `<Gate>` calls the same checkResourceAccess the
 *        gateway calls, so the UI can never offer a button the platform will refuse.
 * HOW    <Gate resource="project" operation="create" fallback={<Upsell/>}>{children}</Gate>
 * WHERE  apps/web/src/features/*
 */
"use client";

import {
  can,
  checkResourceAccess,
  type OperationOf,
  type ResourceKey,
} from "@guardrail/registry";

import { useViewer } from "./viewer";

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
  const { permissions, entitlements } = useViewer();

  // Permission denial is not the customer's business: hide it.
  if (!can(permissions, resource, operation)) return null;

  // Plan denial very much is: show the upsell.
  const decision = checkResourceAccess({ resource, entitlements });
  if (!decision.allowed) return <>{fallback}</>;

  return <>{children}</>;
}

export function useAccess<K extends ResourceKey>(resource: K, operation: OperationOf<K>) {
  const { permissions, entitlements } = useViewer();
  const permitted = can(permissions, resource, operation);
  const decision = checkResourceAccess({ resource, entitlements });
  return { permitted, decision, allowed: permitted && decision.allowed };
}
