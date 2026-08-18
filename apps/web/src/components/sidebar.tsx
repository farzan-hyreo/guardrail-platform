import Link from "next/link";

import { Badge } from "@guardrail/ui/badge";
import type { NavItem, PlanKey } from "@guardrail/registry";

export function Sidebar({ items, plan }: { items: readonly NavItem[]; plan: PlanKey }) {
  return (
    <nav className="w-56 shrink-0 border-r border-border bg-muted/40 px-4 py-8">
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              className="block rounded-md px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
              href={item.href}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-8 px-3">
        <Badge variant="secondary">{plan}</Badge>
      </div>
    </nav>
  );
}
