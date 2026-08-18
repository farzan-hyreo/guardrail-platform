---
name: guardrail-mindset
description: Read this first when working in this repository - how the guardrail platform is put together, which layer owns what, and which other skill to use for the task at hand. Use when orienting in the codebase, when a change spans more than one layer, or when unsure whether something belongs in the registry, the gateway, or a service.
---

# The guardrail platform in one page

Covers: mindset (3:58), 10,000ft overview (18:09).

## The one idea

Nothing in this system relies on remembering. Auth, org scoping, roles, permissions, rate
limits, plan limits, metering and audit are wired into paths every request already takes,
so they cannot be left out of a prompt. When you get an error from the compiler, ESLint or
a service, that error *is* the architecture talking. Read it and follow it. Never suppress
it, never cast around it, never disable a rule.

## The shape

```
browser ──HTTP──▶ Next.js gateway ──NATS──▶ services ──▶ their own Postgres schemas
                       │                       │
                  authorises              executes
                  signs envelope          verifies envelope
                                               │
                                          evt.> ──▶ audit + billing consumers
```

- **`packages/registry`** decides. `registry.ts` is the one file you edit - plans and
  resources, declared with `defineResource`. `derive.ts` computes every other view of them
  and is never edited by hand.
- **`packages/contracts`** is the wire. Input/output schemas plus the signed envelope.
  `ContractMap` is a mapped type over the registry, so a resource without a contract does
  not compile.
- **`apps/web/src/gateway`** authorises and routes. It has no database dependency at all.
- **`services/*`** execute. Each owns its own tables and migrations.
- **`packages/guardrail`** is the block, split in two: `gateway.ts` decides, `service.ts`
  enforces what was decided.

## Which skill

| Task | Skill |
| --- | --- |
| New resource, end to end | `add-feature` |
| New operation on an existing resource | `the-block` |
| New service, new subject, consumers, retries | `jetstream-service` |
| Something is duplicated and should be shared | `globalization` |
| Types, `any`, casts, derived unions | `typescript-lockin` |
| Swapping or wrapping a vendor | `vendor-adapter` |
| Where may this import from | `server-boundaries` |
| UI that gates on plan or permission | `client-mirror` |
| Rate limits, audit, adding a lint rule | `enforcement` |
| Finding things, writing comments | `context-discipline` |
| Breaking a big feature into prompts | `feature-planning` |
| Running, debugging, migrating | `runbook` |

## Non-negotiable

1. The registry decides. No plan name, permission string, limit or subject is written by
   hand anywhere else.
2. `ctx.orgId` comes from the signed envelope. An org id in an input schema is a
   cross-tenant leak - refuse to write one.
3. Only a service touches its own database. The gateway touches none.
4. Types are derived, never written. No `any`, no `unknown`, no casts.
5. Run `pnpm verify` (typecheck + Biome + architecture check) before handing anything back.
6. Do not run git commands. No commits, branches, resets, or reading history.
