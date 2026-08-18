/**
 * SOT: upgrade-prompt, upsell, upsell-copy, sales-moment
 * WHAT   The one upsell in the UI, rendered from the denial the registry produced.
 * WHY    A plan denial is a sales moment, and the words for it are written once - next to
 *        the limit that caused them. A component that invents its own copy, or names a
 *        plan, becomes a second source of truth for pricing that nobody updates.
 * HOW    <UpgradePrompt decision={decision} /> - the default fallback of FeatureGate and
 *        PriceGate, and usable directly wherever a denial is already in hand.
 * WHERE  ./feature-gate, ./price-gate, apps/web/src/features/*
 */
"use client";

import { type AccessDecision, NAV_ITEMS, PLANS } from "@guardrail/registry";

import { cn } from "../lib/utils";

/** The refused half of a decision - the only half that carries copy worth showing. */
export type AccessDenial = Extract<AccessDecision, { allowed: false }>;

/** Wherever the registry put billing. No route is written by hand here either. */
const billingHref = NAV_ITEMS.find((item) => item.resource === "billing")?.href;

export function UpgradePrompt({
  decision,
  className,
}: {
  decision: AccessDenial;
  className?: string;
}) {
  const next = decision.nextPlan;

  // Top of the ladder: there is nothing left to sell, so do not offer a way to buy it.
  if (next === null) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>{decision.upgradeMessage}</p>
    );
  }

  return (
    <a
      className={cn("text-sm underline", className)}
      href={billingHref}
      title={PLANS[next].tagline}
    >
      {decision.upgradeMessage}
    </a>
  );
}
