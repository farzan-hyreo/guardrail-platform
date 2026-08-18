/**
 * SOT: auth-gate, useRole, role-required-ui, minimum-role
 * WHAT   The role half of the client mirror: renders its children only when the viewer's
 *        org role ranks at or above the role the caller asked for.
 * WHY    Roles are ordered, and the order is registry data. A component that writes
 *        `role === "owner"` is the moment "owner" quietly stops implying "admin", and the
 *        UI starts disagreeing with the gateway's own `roleAtLeast` check.
 * HOW    <AuthGate role="owner" fallback={<Explain/>}>{children}</AuthGate>
 * WHERE  apps/web/src/features/*
 */
"use client";

import { type OrgRole, roleAtLeast } from "@guardrail/registry";

import { useViewer } from "./viewer";

export function useRole(): OrgRole {
  return useViewer().role;
}

export function AuthGate({
  role,
  fallback = null,
  children,
}: {
  /** Omitted means "any role the viewer could have" - everyone in the org passes. */
  role?: OrgRole;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  const actual = useRole();
  // Ranked by the registry, never compared as strings. This is the only comparison here.
  const permitted = role === undefined || roleAtLeast(actual, role);
  return permitted ? <>{children}</> : <>{fallback}</>;
}
