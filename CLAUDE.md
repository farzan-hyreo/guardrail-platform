# Guardrail platform

A Next.js gateway, four NATS services, and a registry that decides for both. The
architecture is enforced by the compiler, ESLint and the service runtime - not by this file.

**Start with the `guardrail-mindset` skill.** It maps every task to the skill that covers
it. The skills in `.claude/skills/` are the real instructions; this file is the summary.

## Find before you read

```bash
pnpm sot <keyword>     # the file that owns a concept - paths, not contents
pnpm sot:map           # every concept in the repo
pnpm subjects          # every NATS subject the registry generates
```

Never open a directory to orient yourself.

## The seven rules

1. **The registry decides.** `packages/registry/src/registry.ts` is the only file you edit
   by hand - plans and resources declared with `defineResource`. `derive.ts` computes every
   permission, subject, nav item and plan gate from it. No plan name, permission, limit or
   subject is written by hand anywhere else.
2. **The gateway routes and nothing else.** A gateway route is one line:
   `gatewayQuery("project", "read")`. No conditionals, no database, no transformation.
3. **Services execute and trust nothing.** `defineService` verifies the envelope signature,
   the deadline and the permission before your handler runs.
4. **`ctx.orgId` comes from the signed envelope.** An org id in an input schema is a
   cross-tenant leak. Refuse to write one.
5. **Each service owns its own tables.** No cross-service imports, no cross-service queries,
   even though the database happens to be the same one.
6. **Types are derived, never written.** No `any`, no `!`, no `unknown` outside a parse
   boundary, no casts beyond the two already commented (`fromKeys`, `contractFor`).
   `exactOptionalPropertyTypes` is on: build objects conditionally rather than passing
   `undefined`.
7. **Audit and metering are consumers, not code.** Set `audit: true` / `consumes: true` in
   the registry; never write either by hand.

## Layers

```
browser → gateway (authorise, sign) → NATS → service (verify, execute) → its own schema
                                        └→ evt.> → audit + billing consumers
```

## Conventions

- Next.js 16 uses `src/proxy.ts`, not `middleware.ts`.
- Vendors live behind one adapter each. See the `vendor-adapter` skill.
- Every file opens with a `SOT:` header and `WHAT / WHY / HOW / WHERE`. No `docs/` folder.
- Biome is the only formatter and linter. Environment variables are read only through
  `@guardrail/env`.
- shadcn tokens only. Never hardcode a colour.
- Pages that make no API call are guarded by `app/(dashboard)/layout.tsx`, not the gateway.

## Before handing anything back

- `pnpm verify` - typecheck, Biome, and the architecture check. `make fix` repairs most
  of it automatically. Fix everything that remains. If an autofix ever breaks the build,
  the fix is a narrow, commented override scoped to that rule and file - never weakening
  the rule itself. See `enforcement`.
- Finish the feature end to end. Do not leave a stub and ask for next steps.
- Do not run git commands. No commits, branches, resets, or reading history.
