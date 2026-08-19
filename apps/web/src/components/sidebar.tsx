/**
 * SOT: sidebar, nav-ui, locked-nav, plan-badge-usage
 * WHAT   The navigation, with the plan half of each item's access actually rendered.
 * WHY    `navAccess` returns {visible, locked} and the sidebar used only `visible`, so an
 *        item the plan does not include looked exactly like one it does. Clicking it hit
 *        the layout's redirect and dropped the user on /billing with no explanation. A
 *        locked item is an upgrade prompt; hiding the difference wastes both the prompt and
 *        the click.
 * HOW    A locked item is still a link - it goes somewhere useful - so it is not
 *        `aria-disabled`. It points at billing with `?locked=<resource>`, which the billing
 *        page reads to render that resource's own upgrade copy.
 * WHERE  packages/registry/src/derive.ts (navFor), apps/web/src/app/(dashboard)/billing/page.tsx
 */

import { NAV_ITEMS, type NavEntryAccess, type PlanKey } from "@guardrail/registry";
import { PlanBadge } from "@guardrail/ui/plan-badge";
import { Lock } from "lucide-react";
import Link from "next/link";

/** Wherever the registry put billing. The same lookup upgrade-prompt.tsx makes. */
const billingHref = NAV_ITEMS.find((item) => item.resource === "billing")?.href;

export function Sidebar({ items, plan }: { items: readonly NavEntryAccess[]; plan: PlanKey }) {
  return (
    <nav className="w-56 shrink-0 border-r border-border bg-muted/40 px-4 py-8">
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.href}>
            {item.locked ? (
              <Link
                className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                href={
                  billingHref === undefined ? item.href : `${billingHref}?locked=${item.resource}`
                }
              >
                {item.label}
                <Lock className="size-3.5" aria-hidden="true" />
                <span className="sr-only">Not included in your plan</span>
              </Link>
            ) : (
              <Link
                className="block rounded-md px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
                href={item.href}
              >
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-8 px-3">
        <PlanBadge plan={plan} />
      </div>
    </nav>
  );
}
