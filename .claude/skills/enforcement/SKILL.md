---
name: enforcement
description: Use when adding a rule that must hold everywhere - a lint rule, a rate limit, an audit requirement, a new invariant - or when tempted to write a convention into a comment and hope it is followed. Covers Biome, GritQL plugins, the guardrail check, rate limits and audit.
---

# Enforcement

Covers: enforcement (1:40:00), rate limiting (1:43:19), audit logs (1:45:15).

## The ladder

A rule that lives only in prose gets followed for about three hours. Before writing "always
do X" anywhere, work down this list and stop at the first rung that can hold it:

1. **A type.** Can the wrong version fail to compile? See `typescript-lockin`.
2. **The registry.** Can it be a declared field, so it applies to everything at once?
3. **Biome, natively.** `noRestrictedImports` in a `biome.json` override covers every
   package-level boundary in this repo.
4. **A GritQL plugin** (`tools/grit/*.grit`) for patterns inside a file. Biome 2.5+ applies
   plugin fixes with `biome check --write --unsafe`.
5. **`tools/guardrail-check.ts`** for anything relational - rules that compare a file's own
   path to what it imports. No pattern language can see that, and a rule you cannot express
   is a rule you do not have.
6. **Prose in CLAUDE.md.** Last resort, only for the genuinely unenforceable.

## What is enforced where

| Rule | Mechanism |
| --- | --- |
| No `any`, no non-null assertion, `import type` | Biome native |
| Client-safe packages cannot import server ones | Biome override, `noRestrictedImports` |
| Gateway cannot import a database | Biome override |
| Components cannot import server packages | Biome override |
| No raw `"rpc.x.y"` subject strings | Grit plugin + guardrail check |
| No `process.env` outside `@guardrail/env` | Grit plugin |
| `import "server-only"` in service files | Grit plugin (fix) + guardrail check (`--fix`) |
| One service importing another | guardrail check |
| Business logic in a gateway router | guardrail check |
| **An org id in a contract input** | guardrail check |
| A service answering for a resource it does not own | boot-time throw in `defineService` |

The org-id rule is the highest-value one in the file: an org id accepted as input is a
cross-tenant leak waiting for its first agent-written endpoint.

## Commands

```bash
pnpm check         # Biome lint + format check
pnpm check:fix     # Biome autofix, including plugin fixes
pnpm guardrail     # architecture check
make fix           # both, plus repairs
pnpm verify        # typecheck + check + guardrail — run before handing back
```

## Adding a rule

Biome override for a package boundary. Grit plugin for a pattern - keep it narrow with
`includes`, and write the message as an instruction, because the model reads that message
and acts on it. Anything path-relational goes in `guardrail-check.ts` as a function that
takes `(file, source)` and calls `report()`.

## When an autofix breaks the build

`make fix` runs `pnpm check:fix --unsafe`, and an unsafe autofix occasionally "corrects"
code toward something a *different* rule then rejects - a strict-mode flag `useLiteralKeys`
doesn't know about, say. If that happens, the fix is a narrow override scoped to exactly the
rule and file affected, with the reason written in the override itself. Never turn the rule
off more broadly, and never weaken it repo-wide to make one file's autofix stop fighting
another constraint - a scoped, commented exception is how the rest of the repo keeps the
rule at full strength.

## Rate limiting

Declared per resource in the registry, applied at the gateway before anything reaches the
bus - a limit enforced inside a service has already paid for the work it is refusing.
Change a limit by editing `rateLimit` on the resource; never add a limiter call by hand.
The limiter fails open: an outage in it must not take the product down. Off in development
because hot reload trips it (`RATE_LIMIT_DEV=on` to exercise it).

## Audit and metering

Never write either by hand. Set `audit: true` / `consumes: true` on the operation in
`registry.ts`. The service half of the block emits `evt.<resource>.<operation>`; the audit
service and the billing meter consume it.

That indirection is the point: audit is downstream of the request, so a slow write cannot
slow a customer, and a service cannot forget to audit because it never audits.
