/**
 * SOT: viewer, viewer-context, client-entitlements, plan-context
 * WHAT   Plan, usage, role and permissions in React context.
 * WHY    The client mirror needs the same inputs the gateway had. The dashboard layout
 *        reads them once per navigation and hands them down, so no component makes its
 *        own billing call and no two components disagree about the plan.
 * WHERE  apps/web/src/app/(dashboard)/layout.tsx, @guardrail/ui/gate
 */
"use client";

import {
  EMPTY_ENTITLEMENTS,
  type Entitlements,
  LOWEST_ROLE,
  type OrgRole,
  type Permission,
} from "@guardrail/registry";
import { createContext, useContext } from "react";

export type ViewerState = {
  readonly entitlements: Entitlements;
  readonly permissions: readonly Permission[];
  readonly role: OrgRole;
};

/**
 * The floor: no plan, no permissions, and the least privileged role the registry declares.
 *
 * `role` was the string "member", which is the one thing this package claims never to
 * contain - a role name typed by hand. It failed closed only by coincidence, because
 * `member` happens to be the bottom of ROLE_RANK today. Add a role below it and every
 * component reading `useViewer()` outside a provider would report a HIGHER role than the
 * floor, which is the single direction `normalizeRole` exists to make impossible.
 * `LOWEST_ROLE` is reduced from ROLE_RANK, so the floor moves when the ladder does.
 */
const ViewerContext = createContext<ViewerState>({
  entitlements: EMPTY_ENTITLEMENTS,
  permissions: [],
  role: LOWEST_ROLE,
});

export function ViewerProvider({
  value,
  children,
}: {
  value: ViewerState;
  children: React.ReactNode;
}) {
  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>;
}

export function useViewer(): ViewerState {
  return useContext(ViewerContext);
}
