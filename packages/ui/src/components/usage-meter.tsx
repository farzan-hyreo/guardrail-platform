/**
 * SOT: usage-meter, allowance-bar, usage-display, headroom
 * WHAT   How much of a resource's allowance is spent, phrased by the registry.
 * WHY    The billing page printed a bare string per row and the team page printed
 *        "Seats 3" - two hand-written renderings of a number the registry already knows how
 *        to say. `usageLabel` produces "3 of 10", "12 used" or "Not included" from the plan
 *        and the usage snapshot, so a plan whose limit changes changes every screen at once.
 * HOW    <UsageMeter resource="member" /> - reads the viewer context the layout populated,
 *        so it costs no request.
 * HOW    The bar is drawn only when the limit is a number. "unlimited" has no fraction to
 *        show and "not included" has no allowance at all; inventing a full or empty bar for
 *        either would be a claim the registry never made.
 * WHERE  apps/web/src/app/(dashboard)/billing/page.tsx, apps/web/src/features/team/*
 */
"use client";

import { limitFor, RESOURCES, type ResourceKey } from "@guardrail/registry";

import { cn } from "../lib/utils";
import { useUsageLabel } from "./price-gate";
import { useViewer } from "./viewer";

export function UsageMeter({
  resource,
  className,
}: {
  readonly resource: ResourceKey;
  readonly className?: string;
}) {
  const { entitlements } = useViewer();
  const label = useUsageLabel(resource);
  const limit = limitFor(resource, entitlements.plan);
  // `?? 0` is required by noUncheckedIndexedAccess, and is what checkResourceAccess does.
  const used = entitlements.usage[resource] ?? 0;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between text-sm">
        <span>{RESOURCES[resource].label}</span>
        <span className="tabular-nums text-muted-foreground">{label}</span>
      </div>
      {typeof limit === "number" ? (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={used}
          aria-label={`${RESOURCES[resource].label}: ${label}`}
        >
          {/* The inline style carries a computed width, never a colour - the token rule is
              about colour, and a percentage cannot be expressed as a utility class. */}
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${String(Math.min(100, Math.round((used / limit) * 100)))}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
