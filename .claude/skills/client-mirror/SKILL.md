---
name: client-mirror
description: Use when building UI that depends on a plan, a permission, a limit or a role - buttons that should be hidden, disabled or replaced by an upgrade prompt - and when adding shadcn components. Covers Gate, useAccess, the viewer context and component conventions.
---

# The client mirror and the UI

Covers: the client mirror (1:45:57), shadcn conventions.

## The mirror

The browser and the gateway call the *same* pure function, `checkResourceAccess()` in
`@guardrail/registry`. That is the only reason a button and an endpoint cannot disagree.
Never re-implement a limit check in a component, and never hardcode a plan name in JSX.

```tsx
<Gate
  resource="project"
  operation="create"
  fallback={<UpgradePrompt />}   // shown when the PLAN blocks it
>
  <Button onClick={...}>Create project</Button>
</Gate>
```

- **Permission denied → render nothing.** Someone who cannot do it does not need to know
  it exists.
- **Plan denied → render the fallback.** This is a sales moment, not an error.

`useAccess(resource, operation)` returns `{ permitted, decision, allowed }` when you need
the reason rather than the branch - the denial carries `upgradeMessage` and `nextPlan`
already written by the registry.

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
