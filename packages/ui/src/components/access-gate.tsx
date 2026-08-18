/**
 * SOT: access-gate, usePermission, permission-mirror, hide-when-denied
 * WHAT   The permission half of the client mirror: renders its children only when the
 *        viewer's role actually holds `<resource>:<operation>`.
 * WHY    A permission denial is not a sales moment and not an error - it is a non-event.
 *        Someone who may not do a thing does not need to learn that the thing exists, so
 *        this gate has no fallback slot at all.
 * HOW    <AccessGate resource="member" operation="create"><Invite/></AccessGate>
 *        usePermission("member", "create") when a boolean is what you need.
 * WHERE  apps/web/src/features/*, ./gate
 */
"use client";

import { can, type OperationOf, type ResourceKey } from "@guardrail/registry";

import { useViewer } from "./viewer";

/** The same `can` the gateway calls, over the permissions the layout already loaded. */
export function usePermission<K extends ResourceKey>(
  resource: K,
  operation: OperationOf<K>,
): boolean {
  const { permissions } = useViewer();
  return can(permissions, resource, operation);
}

export function AccessGate<K extends ResourceKey>({
  resource,
  operation,
  children,
}: {
  resource: K;
  operation: OperationOf<K>;
  children: React.ReactNode;
}) {
  const permitted = usePermission(resource, operation);
  return permitted ? <>{children}</> : null;
}
