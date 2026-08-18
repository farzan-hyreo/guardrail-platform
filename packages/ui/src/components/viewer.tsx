/**
 * SOT: viewer, viewer-context, client-entitlements, plan-context
 * WHAT   Plan, usage, role and permissions in React context.
 * WHY    The client mirror needs the same inputs the gateway had. The dashboard layout
 *        reads them once per navigation and hands them down, so no component makes its
 *        own billing call and no two components disagree about the plan.
 * WHERE  apps/web/src/app/(dashboard)/layout.tsx, @guardrail/ui/gate
 */
"use client";

import { createContext, useContext } from "react";

import { EMPTY_ENTITLEMENTS, type Entitlements, type OrgRole, type Permission } from "@guardrail/registry";

export type ViewerState = {
  readonly entitlements: Entitlements;
  readonly permissions: readonly Permission[];
  readonly role: OrgRole;
};

const ViewerContext = createContext<ViewerState>({
  entitlements: EMPTY_ENTITLEMENTS,
  permissions: [],
  role: "member",
});

export function ViewerProvider({ value, children }: { value: ViewerState; children: React.ReactNode }) {
  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>;
}

export function useViewer(): ViewerState {
  return useContext(ViewerContext);
}
