---
name: typescript-lockin
description: Use when writing or changing a type, when tempted to use any/unknown/as or a non-null assertion, when a type error looks like it needs silencing, or when deciding where a type should live. Covers derived types, the strict flags in use and the two sanctioned assertions.
---

# TypeScript lock-in

Covers: TypeScript lock-in (50:42).

## The point

Types here are not documentation, they are the enforcement mechanism. A compile error is
the system refusing an unsafe change. Silencing one with a cast disables a guardrail.

## The strict flags, and what each one will do to you

`tsconfig.base.json` runs `strict` plus:

| Flag | Consequence you will meet |
| --- | --- |
| `noUncheckedIndexedAccess` | `array[0]` is `T \| undefined`. Handle it, do not `!` it. |
| `exactOptionalPropertyTypes` | `{ x?: string }` will not accept `x: undefined`. Build the object conditionally: `...(v === undefined ? {} : { x: v })`. |
| `noPropertyAccessFromIndexSignature` | `process.env.FOO` is an error. Use `@guardrail/env`. |
| `noImplicitReturns` | every branch returns, or none does. |
| `noUnusedLocals` / `noUnusedParameters` | dead code fails the build. |
| `erasableSyntaxOnly` | no enums, no parameter properties. Use `as const` objects. |
| `verbatimModuleSyntax` | type imports must say `import type`. |

`exactOptionalPropertyTypes` is the one most likely to surprise you. It is on deliberately:
"absent" and "present but undefined" are different states, and conflating them is how
optional fields silently overwrite real data.

## Rules

1. **Never write a type that can be derived.** Rows: `typeof table.$inferSelect`. Wire
   shapes: `InputOf<K, O>` / `OutputOf<K, O>`. Permissions, subjects, nav, plan records:
   `packages/registry/src/derive.ts`.
2. **No `any`.** Biome errors on it.
3. **`unknown` only at a trust boundary**, and narrowed by a zod parse in the same function.
   There are exactly two: `HandlerEntry.execute` and the raw envelope.
4. **No non-null assertions.** Biome errors on `!`. If you need narrowing after a failure
   path, annotate the thrower explicitly - see `fail` in `guardrail/src/gateway.ts`, whose
   `(failure) => never` annotation is what lets the compiler narrow afterwards.
5. **Two sanctioned assertions exist**, both commented, both provably sound:
   - `fromKeys` in `registry/src/define.ts` - total because it visits the exact key list.
   - `contractFor` in `contracts/src/contracts.ts` - restates a relationship through a
     mapped type that the compiler cannot follow; it does not invent one.
   Do not add a third without writing why in a comment above it.
6. **`satisfies`, never an annotation,** on registry data. An annotation widens the literals
   and every derived union collapses to `string`. `const` type parameters on
   `defineResource` mean you do not even need `as const`.
7. **Add a field to `RequestMeta`, add it to `canonicalRequest`.** The envelope's signature
   covers the exact object `canonicalRequest` builds in `contracts/src/envelope.ts`, not
   `requestMeta` itself. That object is typed
   `satisfies Record<keyof RequestMeta | "payloadHash", unknown>`, so a field you add to
   `requestMeta` and forget to add there is a **compile error**, not a field that quietly
   lands on the unsigned side of the boundary. You will hit this the moment you extend
   `RequestMeta` - go add the field to the canonical object in the same change, not as a
   follow-up.

## Reading an error

| Error | What it is telling you |
| --- | --- |
| Missing property in `ContractMap` | you declared an operation with no contract |
| `Record<PlanKey, ...>` missing a key | a plan was added; fill in its limits deliberately |
| Handler input is `never` | contract and registry disagree about that operation |
| `Type 'undefined' is not assignable` | `exactOptionalPropertyTypes`; build the object conditionally |

Fix the cause. Casting past any of these puts a runtime hole where a compile error was.
