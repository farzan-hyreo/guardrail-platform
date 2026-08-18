---
name: globalization
description: Use when you notice the same logic, constant, or rule appearing in more than one place, when deciding whether something belongs in the registry, and when adding a plan, permission, limit, nav entry or role. Covers what to globalize and what to leave alone.
---

# Globalization

Covers: globalization (33:26), the registry.

## The test

Globalize when the same **fact** is needed by two layers that must never disagree - the
gateway and a service, the server and the browser, the API and the nav. Do not globalize
because two pieces of code look similar. Similar code that answers different questions
should stay apart; it will diverge, and it should be allowed to.

| Fact | Where it goes |
| --- | --- |
| A plan exists / costs / ranks | `registry/registry.ts` |
| A resource, its operations, roles, limits, timeouts | `registry/registry.ts` |
| A permission string | `registry/derive.ts` - computed, never written |
| Whether a plan may do a thing | `registry/derive.ts` |
| A NATS subject or stream | `registry/derive.ts` - computed, never written |
| A wire shape | `packages/contracts` |
| A pure rule both sides need (slugify, formatting) | `features/<name>/rules.ts` |

## What must never be globalized

- Business logic. It belongs in the owning service's handlers, even if two services
  currently do something similar.
- A service's queries. Sharing a query means sharing a table, which means the service
  boundary was drawn wrong.
- Anything importing `server-only` into a file the browser will load.

## Adding to the registry

The registry has exactly two files you care about: `registry.ts` declares, `derive.ts`
computes. **Only ever edit `registry.ts`.** Adding data to `derive.ts` creates a second
source of truth, and `pnpm guardrail` will fail you for it.

Add the key, then run `pnpm typecheck` and let it tell you what to fill in. `Record<PlanKey, ...>`
and `ContractMap` are exhaustive, so every place that needed updating will fail until it is.
That list of errors is the work.

## Deriving instead of writing

If you are typing a value that could be computed from something already in the registry,
compute it. `PERMISSIONS`, `NAV_ITEMS`, `allSubjects()`, `resourcesOwnedBy()` and the Better
Auth access-control roles are all derived. Adding a hand-maintained parallel list is the
one change most likely to cause a security bug six months from now.
