---
name: client-mirror
description: Use when building UI that depends on a plan, a permission, a limit or a role - buttons that should be hidden, disabled or replaced by an upgrade prompt - and when adding shadcn components. Covers Gate, AccessGate, AuthGate, FeatureGate, PriceGate, UpgradePrompt, useAccess, the viewer context and component conventions.
---

# The client mirror and the UI

Covers: the client mirror (1:45:57), shadcn conventions.

## The mirror

The browser and the gateway call the *same* pure functions - `checkResourceAccess()` and
`can()` in `@guardrail/registry`. That is the only reason a button and an endpoint cannot
disagree. Never re-implement a limit check in a component, and never hardcode a plan name
in JSX.

`<Gate>` (`packages/ui/src/components/gate.tsx`) owns no rule of its own - it composes
three single-purpose gates in the order the platform applies them, permission first:

```tsx
<Gate
  resource="project"
  operation="create"
  fallback={<UpgradePrompt />}   // shown when the PLAN blocks it, not the permission
>
  <Button onClick={...}>Create project</Button>
</Gate>
```

- **Permission denied → render nothing.** Someone who cannot do it does not need to know
  it exists.
- **Plan denied → render the fallback.** This is a sales moment, not an error.

Reach for the three primitives `Gate` composes directly when their answers deserve three
different answers instead of one collapsed fallback:

| Component | Question | Fallback slot? | Default when denied |
| --- | --- | --- | --- |
| `AccessGate` | Does the role hold this `resource:operation` permission? | None | Renders nothing - a permission denial is a non-event, not a sales moment |
| `FeatureGate` | Is this resource in the plan **at all**? | `fallback` prop | `<UpgradePrompt/>` with "not in your plan" copy |
| `PriceGate` | Is the resource in the plan but the **allowance spent**? | `fallback` prop | `<UpgradePrompt/>` with "you are out of quota" copy |

`AuthGate` is a separate primitive, not one `Gate` composes - it gates on org **role**
(`roleAtLeast()`) rather than on a registry `resource:operation` permission, for UI that
should only show to (say) owners and admins regardless of which specific action they are
about to take:

| Component | Question | Fallback slot? | Default when denied |
| --- | --- | --- | --- |
| `AuthGate` | Does the role rank at or above a minimum? | `fallback` prop, defaults to `null` | Whatever you pass |

`FeatureGate` and `PriceGate` are deliberately two different components with two different
messages, not one "plan denied" gate: telling a paying customer their feature is "not
included" when they have simply used it up for the month is the wrong sales conversation.
`FeatureGate` answers `decision.reason === "not_in_plan"`; `PriceGate` answers
`decision.reason === "limit_reached"`; each ignores the other's reason and renders
`children` in that case, because it isn't its conversation to have.

`<UpgradePrompt decision={decision} />` is the one upsell component in the UI - the default
fallback of both `FeatureGate` and `PriceGate`, and usable directly wherever you already
have an `AccessDecision` in hand. It reads `decision.upgradeMessage` and `decision.nextPlan`
from the registry rather than inventing copy, and links to wherever the registry put
billing (`NAV_ITEMS`). Never write upgrade copy or a plan name in a component.

### Hooks

- `useAccess(resource, operation)` → `{ permitted, decision, allowed }` when you need the
  reason rather than the branch - `decision` carries `upgradeMessage` and `nextPlan`.
- `usePermission(resource, operation)` → boolean, the permission half alone.
- `useRole()` → the viewer's `OrgRole`, ranked by the registry - never compare it as a raw
  string; use `roleAtLeast()`.
- `useResourceDecision(resource, requested?)` → the raw `AccessDecision`, what `FeatureGate`
  and `PriceGate` are both built on.
- `useUsageLabel(resource)` → the registry's own phrasing ("3 of 10", "12 used", "Not
  included") - never format a usage count by hand in a component.

## Where the state comes from

`app/(dashboard)/layout.tsx` fetches entitlements once per navigation and puts them in
`ViewerProvider`. Components read `useViewer()`. **Never fetch entitlements in a component** -
that is a billing round trip per render.

## shadcn/ui

Components live in `packages/ui/src/components/ui/`. Add more with:

```bash
pnpm ui:add dialog dropdown-menu select
```

Conventions:
- Never hardcode a colour. Use the token classes - `bg-primary`, `text-muted-foreground`,
  `border-border`. `apps/web/src/app/globals.css` owns the tokens, and light/dark both
  follow from there.
- Every component takes `className` and merges it with `cn()`.
- A component that appears in two features moves to `packages/ui`; one used by a single
  feature stays in `apps/web/src/features/<name>/`.
- Compose with slots (pass a node as a prop) rather than adding a boolean prop per variant.

## Error handling in the UI

Denials arrive structured on `error.data.app`, not as a string. Match on `code`:
`UPGRADE_REQUIRED` gets an upsell, `RATE_LIMITED` gets "try again shortly" with the retry
seconds, everything else gets the message as written. Never regex an error message.
