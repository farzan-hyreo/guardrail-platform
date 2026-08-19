/**
 * SOT: plan-badge, plan-label, plan-name-display
 * WHAT   The viewer's plan, named the way the registry names it.
 * WHY    The sidebar rendered `{plan}` and the billing page wrote "the {plan} plan", so
 *        both showed the key - "free", "pro" - rather than the label the registry declares
 *        beside the price. A plan key is an identifier; a label is copy, and copy lives in
 *        the registry with the price it belongs to.
 * HOW    <PlanBadge plan={entitlements.plan} /> - takes the plan as a prop rather than
 *        reading the viewer context, because its caller is the sidebar, which is a server
 *        component. A hook here would force the whole nav into the client bundle.
 * WHERE  apps/web/src/components/sidebar.tsx
 */
import { nextPlanAfter, PLANS, type PlanKey } from "@guardrail/registry";

import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

export function PlanBadge({
  plan,
  className,
}: {
  readonly plan: PlanKey;
  readonly className?: string;
}) {
  // Top of the ladder gets the emphasised variant. Derived, so a plan added above the
  // current top moves the emphasis without an edit here.
  const isTopPlan = nextPlanAfter(plan) === null;
  return (
    <Badge
      variant={isTopPlan ? "default" : "secondary"}
      className={cn(className)}
      title={PLANS[plan].tagline}
    >
      {PLANS[plan].label}
    </Badge>
  );
}
