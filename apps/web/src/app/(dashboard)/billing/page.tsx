/**
 * SOT: billing-page, plan-overview, locked-resource-explainer
 * WHAT   Plan, usage per resource, and the upgrade path.
 * WHY    Two things arrive here that nothing used to read. The dashboard layout redirects a
 *        locked resource to `/billing?locked=<resource>`, and this page ignored the
 *        parameter - so somebody who clicked "Audit log" on the free plan was teleported to
 *        a billing screen that said nothing about why. And the plan was printed as its raw
 *        key ("free"), not the label the registry gives it.
 * HOW    `locked` is validated with `isResourceKey` before it indexes anything: it arrives
 *        in a URL, so it is attacker-controlled input until the registry recognises it.
 * WHERE  apps/web/src/app/(dashboard)/layout.tsx, apps/web/src/features/billing/plan-table.tsx
 * NOTE   biome.json turns complexity/useLiteralKeys off for every page under app. Next
 *        types searchParams as an index signature, and `noPropertyAccessFromIndexSignature`
 *        makes `params.locked` a TS4111 error - so Biome's suggested rewrite would break
 *        the build, exactly as it would in @guardrail/env. biome.json takes no comments, so
 *        the reason lives here.
 */
import { checkResourceAccess, isResourceKey, PLANS } from "@guardrail/registry";
import { Card, CardContent } from "@guardrail/ui/card";
import { UpgradePrompt } from "@guardrail/ui/upgrade-prompt";
import { UsageMeter } from "@guardrail/ui/usage-meter";

import { PlanTable } from "@/features/billing/plan-table";
import { api } from "@/trpc/server";

export default async function BillingPage({
  searchParams,
}: {
  // Next.js 16: searchParams is a Promise.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const overview = await api.billing.overview({});
  const params = await searchParams;

  // Bracket access, because noPropertyAccessFromIndexSignature is on.
  const raw = params["locked"];
  const locked = typeof raw === "string" && isResourceKey(raw) ? raw : null;
  const denial =
    locked === null
      ? null
      : checkResourceAccess({ resource: locked, entitlements: overview.entitlements });

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="text-muted-foreground">
          You are on the {PLANS[overview.entitlements.plan].label} plan.
        </p>
      </header>

      {denial !== null && !denial.allowed ? (
        <Card>
          <CardContent className="p-5">
            <UpgradePrompt decision={denial} />
          </CardContent>
        </Card>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Usage</h2>
        <Card>
          <CardContent className="space-y-4 p-5">
            {overview.resources.map((row) => (
              <UsageMeter key={row.resource} resource={row.resource} />
            ))}
          </CardContent>
        </Card>
      </section>

      <PlanTable current={overview.entitlements.plan} />
    </div>
  );
}
