/**
 * SOT: plan-table, pricing-table, checkout-ui, plan-picker
 * WHAT   The upgrade path, built from the registry and routed through the block.
 * WHY    This replaces Autumn's <PricingTable/>. That widget talked to the vendor's own
 *        endpoints, mounted under /api/auth/autumn/* by a better-auth plugin - no role
 *        gate, no per-org rate limit, no audit row, and a second way into the vendor
 *        beside the adapter. `billing.manage` already existed for this: owner-only,
 *        `audit: true`, rate limited per org, served straight into the same adapter. It
 *        had no caller. This is the caller.
 * WHY    The plans, their prices, their order and the current one all come from the
 *        registry, so adding a plan to `PLANS` puts a column here with no edit to this
 *        file - and no screen in the product can quote a price the registry disagrees with.
 * HOW    <PlanTable current={entitlements.plan} /> from the billing page.
 * WHERE  packages/registry/src/registry.ts, apps/web/src/gateway/routers/billing.router.ts
 */
"use client";

import { PLANS, PLANS_ASCENDING, type PlanKey, planRank } from "@guardrail/registry";
import { Button } from "@guardrail/ui/button";
import { Card, CardContent } from "@guardrail/ui/card";
import { Denial } from "@guardrail/ui/denial";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { useTRPC } from "@/trpc/react";

/** Never formatted by hand twice: one place decides what "$29" and "Free" look like. */
function priceLabel(plan: PlanKey): string {
  const price = PLANS[plan].priceMonthlyUsd;
  return price === 0 ? "Free" : `$${String(price)}/mo`;
}

export function PlanTable({ current }: { current: PlanKey }) {
  const trpc = useTRPC();
  const [pending, setPending] = useState<PlanKey | null>(null);

  const checkout = useMutation(
    trpc.billing.checkout.mutationOptions({
      onSuccess: (result) => {
        // A null url means the plan changed without a payment step - nothing to visit.
        if (result.url !== null) window.location.assign(result.url);
        else window.location.reload();
      },
      onSettled: () => {
        setPending(null);
      },
    }),
  );

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">Plans</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        {PLANS_ASCENDING.map((plan) => {
          const isCurrent = plan === current;
          const isDowngrade = planRank(plan) < planRank(current);
          return (
            <Card key={plan} className={isCurrent ? "border-primary" : undefined}>
              <CardContent className="space-y-3 p-5">
                <div>
                  <h3 className="font-medium">{PLANS[plan].label}</h3>
                  <p className="text-2xl font-semibold tabular-nums">{priceLabel(plan)}</p>
                </div>
                <p className="text-sm text-muted-foreground">{PLANS[plan].tagline}</p>
                <Button
                  className="w-full"
                  variant={isCurrent ? "outline" : "default"}
                  disabled={isCurrent || checkout.isPending}
                  onClick={() => {
                    setPending(plan);
                    checkout.mutate({ plan, successUrl: window.location.href });
                  }}
                >
                  {isCurrent
                    ? "Current plan"
                    : pending === plan && checkout.isPending
                      ? "Starting…"
                      : isDowngrade
                        ? `Switch to ${PLANS[plan].label}`
                        : `Upgrade to ${PLANS[plan].label}`}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
      {/* The structured refusal, not error.message painted red. A non-owner reaching this
          gets the gateway's PERMISSION_DENIED; a rate limit gets its retry seconds. */}
      <Denial error={checkout.error} resource="billing" />
    </section>
  );
}
