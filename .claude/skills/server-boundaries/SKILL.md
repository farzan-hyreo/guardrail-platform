---
name: server-boundaries
description: Use when deciding where a file or an import belongs, when adding a page that does not call the API, when an import is blocked by lint, or when anything touches a database, a secret or the message bus. Covers server-only, database isolation and the route-guard gap.
---

# Boundaries

Covers: server-only (1:10:42), the gap (1:47:10).

## Who may import what

| Layer | May import | May never import |
| --- | --- | --- |
| `packages/registry`, `packages/contracts`, `packages/ui` | zod, better-auth/access | `server-only`, `@guardrail/db`, `@guardrail/env`, `@guardrail/transport` |
| `apps/web/src/gateway` | guardrail, transport, auth, contracts | any database, any service |
| `apps/web` components | `@guardrail/ui`, registry, trpc client | anything under `@guardrail/*` server packages |
| `services/<name>` | its own db + schema, guardrail, contracts | another service, `@guardrail/auth` |

The gateway has **no database dependency in its package.json**. That is a stronger
guarantee than a lint rule: the types do not exist there to be misused.

## server-only

Every `*.service.ts`, `*.adapter.ts`, `*.handlers.ts` and `src/db.ts` must open with
`import "server-only";`. The architecture check auto-fixes it - run `pnpm guardrail:fix` rather than
adding it by hand.

It exists because a secret or a database URL in a client bundle is not a bug you find in
review, it is one you find in a security report.

## The gap

The block only protects requests that reach it. These do not:

- Pages rendering a third-party widget (Autumn's `<PricingTable/>`) that make no API call.
- Static pages under a URL that implies access.
- Anything a customer can reach by pasting a URL.

`apps/web/src/app/(dashboard)/layout.tsx` closes this by mapping the pathname to a resource
via `resourceForPath()` and applying the same permission and plan rules. **Any new page of
that kind must sit under that layout**, and if it needs a URL outside `(dashboard)`, add the
same guard there and say why in a comment.

Test it the way an attacker would: sign in as a `member`, paste the `/audit` URL, and
confirm the redirect. Do not test it by clicking the nav - the nav already hid the link.

## Never

- A database import in the gateway or a component.
- A `process.env` secret read in a file without `server-only`.
- A page under `(dashboard)` that assumes the layout ran but is actually rendered elsewhere.
