/**
 * SOT: dashboard-layout, route-guard, nav-gate, the-gap
 * WHAT   The guard for the gap the gateway cannot cover.
 * WHY    A page that renders a third-party widget - Autumn's pricing table, an embedded
 *        provider component - makes no tRPC call, so no envelope is ever built and the URL
 *        is otherwise open. This layout applies the same registry rules to the route.
 * HOW    proxy.ts sets x-pathname; the registry maps path to resource; the same functions
 *        the gateway uses decide whether to render.
 */

import { identify } from "@guardrail/auth";
import { navAccess, navFor, permissionsForRole, resourceForPath } from "@guardrail/registry";
import { ViewerProvider } from "@guardrail/ui/viewer";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Sidebar } from "@/components/sidebar";
import { gatewayDeps } from "@/gateway/deps";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const identity = await identify(requestHeaders);

  if (!identity) redirect("/sign-in");

  const entitlements = await gatewayDeps.entitlements(identity.orgId);
  const permissions = permissionsForRole(identity.role);

  const pathname = requestHeaders.get("x-pathname") ?? "/";
  const resource = resourceForPath(pathname);
  if (resource) {
    const access = navAccess(resource, identity.role, entitlements);
    if (!access.visible) redirect("/projects");
    if (access.locked) redirect(`/billing?locked=${resource}`);
  }

  return (
    <ViewerProvider value={{ entitlements, permissions, role: identity.role }}>
      <div className="flex min-h-dvh">
        <Sidebar items={navFor(identity.role, entitlements)} plan={entitlements.plan} />
        <main className="flex-1 px-8 py-8">{children}</main>
      </div>
    </ViewerProvider>
  );
}
